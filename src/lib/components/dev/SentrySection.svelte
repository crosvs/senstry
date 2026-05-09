<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { identity, pairedDevices } from '$lib/store/identity';
  import { settings } from '$lib/store/settings';
  import {
    sources, sensors, captures, nostrActions, links, loadPipeline,
    storageCleanup, loadStorageCleanup,
    type SensorState, type LinkActivationState, type CaptureMethod,
  } from '$lib/store/pipeline';
  import { AudioDetector } from '$lib/detectors/audio';
  import { ScheduleDetector } from '$lib/detectors/schedule';
  import { TimeWindowDetector } from '$lib/detectors/timewindow';
  import { DateRangeDetector } from '$lib/detectors/daterange';
  import type { DetectionEvent } from '$lib/detectors/types';
  import { capturePhotosOnTrigger } from '$lib/detectors/photo';
  import { saveSegment, pinRange, thinSegments, evictUnpinned, expirePinnedSegments, SEGMENT_DURATION_S } from '$lib/db/segments';
  import { createFootageRef, updateFootageRef } from '$lib/db/footage';
  import { buildTriggerEvent, buildFootageRefEvent } from '$lib/nostr/events';
  import { publish, getRelays } from '$lib/nostr/client';
  import { enqueue } from '$lib/db/outbox';
  import {
    setMonitorStream, setMonitorStreams, setIdleTimeout, handleOfferRequest,
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

  // ── Types ─────────────────────────────────────────────────────────────────

  export type AlertSession = {
    linkId: string;
    linkName: string;
    sourceId: string;
    startTime: number;
    endTime: number;
    mimeType: string;
  };

  // ── Props ─────────────────────────────────────────────────────────────────

  interface Props {
    signalRouterActive?: boolean;
    autoAccept?: boolean;
    sensorStates?: Record<string, SensorState>;
    linkStates?: Record<string, LinkActivationState>;
    activeAlerts?: AlertSession[];
    onPendingOffer?: (fromPubkey: string, msg: SignalMessage) => void;
    acceptOffer?: { fromPubkey: string; msg: SignalMessage } | null;
  }
  let {
    signalRouterActive = $bindable(false),
    autoAccept = $bindable(true),
    sensorStates = $bindable<Record<string, SensorState>>({}),
    linkStates = $bindable<Record<string, LinkActivationState>>({}),
    activeAlerts = $bindable<AlertSession[]>([]),
    onPendingOffer,
    acceptOffer = null,
  }: Props = $props();

  // ── Local state ───────────────────────────────────────────────────────────

  let error = $state('');
  let showRaw = $state(false);
  let monitorSnapshot = $state<{ settings: typeof $settings; pipeline: object } | null>(null);
  let sessions = $state<MonitorSessionInfo[]>([]);
  let showPreview = $state<Record<string, boolean>>({});
  let signalSub: { close: () => void } | null = null;
  let sessionTick: ReturnType<typeof setInterval>;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  // Reactive set of open source IDs — updated whenever streams are opened/closed
  let openSourceIds = $state(new Set<string>());
  // Per-source dB level for display meters (mic sources only)
  let sourceDb = $state(new Map<string, number>());
  let meterRaf: number | null = null;
  let meterCtx: AudioContext | null = null;
  const meterAnalysers = new Map<string, { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> }>();
  let videoEl: HTMLVideoElement | undefined = $state();

  // ── Multi-source execution state ──────────────────────────────────────────

  // One MediaStream per open source
  const openStreams = new Map<string, MediaStream>();
  // In-flight open promises — prevents duplicate getUserMedia/getDisplayMedia calls when
  // _ensureStream is called concurrently for the same source (e.g., rapid sensor state changes).
  const pendingStreams = new Map<string, Promise<MediaStream | null>>();
  // One detector per sensor (AudioDetector or ScheduleDetector)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface SensorDetector {
    start(stream?: MediaStream): void;
    stop(): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onDetection: ((event: DetectionEvent<any>) => void) | null;
    onStateChange: ((state: SensorState) => void) | null;
  }
  const activeDetectors = new Map<string, SensorDetector>();
  // Per-source recorder state: current MediaRecorder + which capture method it's running
  interface RecorderSlot {
    recorder: MediaRecorder | null;
    captureId: string | null;
    segmentStart: number;
    chunks: Blob[];
  }
  const recorderSlots = new Map<string, RecorderSlot>();
  // Per-link active state tracking (for minStateDurationMs timers)
  const linkActivationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Set of link IDs currently firing
  const firingLinks = new Set<string>();

  // Footage session accumulator per link (for FootageRef window management)
  interface FootageSession {
    refId: string;
    startTime: number;
    endTime: number;
    mimeType: string;
    timer: ReturnType<typeof setTimeout> | null;
  }
  const footageSessions = new Map<string, FootageSession>();

  function syncAlerts() {
    activeAlerts = [...footageSessions.entries()].map(([linkId, s]) => {
      const link = get(links).find(l => l.id === linkId);
      const capture = link?.captureId ? get(captures).find(c => c.id === link.captureId) : null;
      return {
        linkId, linkName: link?.name ?? linkId,
        sourceId: capture?.sourceId ?? 'default-mic',
        startTime: s.startTime, endTime: s.endTime, mimeType: s.mimeType,
      };
    });
  }

  sessionTick = setInterval(() => { sessions = getMonitorSessionInfos(); }, 2000);

  $effect(() => {
    if (acceptOffer && $identity) {
      handleOfferRequest($identity.privkey, $identity.pubkey, acceptOffer.msg, acceptOffer.fromPubkey).catch(() => {});
    }
  });

  // ── Signal router ─────────────────────────────────────────────────────────

  function startRouter() {
    if (!$identity || signalSub) return;
    signalSub = startSignalRouter(
      $identity.privkey, $identity.pubkey,
      async (msg, fromPubkey) => {
        if (!$identity) return;
        if (msg.type === 'offer-request') {
          if (autoAccept) await handleOfferRequest($identity.privkey, $identity.pubkey, msg, fromPubkey);
          else onPendingOffer?.(fromPubkey, msg);
        } else if (msg.type === 'answer') {
          await handleAnswer(msg, fromPubkey);
        } else if (msg.type === 'hangup') {
          handleHangup(msg, fromPubkey);
        }
      },
      async (msg, fromPubkey) => { await handleViewerSignal(msg, fromPubkey); }
    );
    signalRouterActive = true;
  }

  function stopRouter() {
    signalSub?.close();
    signalSub = null;
    signalRouterActive = false;
  }

  // ── Monitor lifecycle ─────────────────────────────────────────────────────

  async function startMonitor() {
    if (!$identity) return;
    error = '';
    transitionMonitor('starting');
    await loadPipeline();
    monitorSnapshot = { settings: { ...$settings }, pipeline: {
      sources: $sources, sensors: $sensors, captures: $captures,
      nostrActions: $nostrActions, links: $links,
    }};
    await navigator.storage?.persist().catch(() => {});

    try {
      // Determine which sources are needed:
      // - sensor sources (for detection)
      // - non-screen capture sources for enabled links (so they're ready for WebRTC before any trigger fires)
      const neededSourceIds = new Set<string>();
      for (const sensor of $sensors.filter(s => s.enabled && s.type === 'audio')) {
        neededSourceIds.add(sensor.sourceId);
      }
      for (const link of $links.filter(l => l.enabled && l.captureId)) {
        const cap = $captures.find(c => c.id === link.captureId);
        if (!cap) continue;
        // All capture sources — including photo (camera) and screen — must be opened here
        // during the Start Monitor button click (a user gesture). Lazy opening from a sensor
        // callback is not a user gesture and will be silently skipped or cause repeated prompts.
        neededSourceIds.add(cap.sourceId);
      }

      // Open streams for all needed sources (exclude sentinel 'none' used by schedule/time sensors)
      for (const sourceId of neededSourceIds) {
        if (sourceId && sourceId !== 'none') await _ensureStream(sourceId);
      }

      // Pass all open source streams so viewers can receive any source.
      setMonitorStreams(new Map(openStreams));
      // Preview: prefer camera or screen source, fall back to mic
      const videoEntry = [...openStreams.entries()].find(([id]) =>
        $sources.find(s => s.id === id && (s.type === 'camera' || s.type === 'screen'))
      );
      const previewStream = videoEntry?.[1] ?? openStreams.get('default-mic') ?? [...openStreams.values()][0] ?? null;
      if (videoEl && previewStream) videoEl.srcObject = previewStream;
      setIdleTimeout($settings.rtcIdleTimeoutMs);

      _startMeters();

      // Start sensors
      for (const sensor of $sensors.filter(s => s.enabled)) {
        let det: SensorDetector;
        if (sensor.type === 'schedule') {
          det = new ScheduleDetector({ intervalMs: sensor.intervalMs, settlingMs: sensor.settlingMs });
        } else if (sensor.type === 'timewindow') {
          det = new TimeWindowDetector({
            startHHMM: sensor.startHHMM, endHHMM: sensor.endHHMM, daysOfWeek: sensor.daysOfWeek,
          });
        } else if (sensor.type === 'daterange') {
          det = new DateRangeDetector({ startIso: sensor.startIso, endIso: sensor.endIso });
        } else {
          const stream = openStreams.get(sensor.sourceId);
          if (!stream) continue;
          const aDet = new AudioDetector({
            thresholdDb: sensor.thresholdDb,
            releaseThresholdDb: sensor.releaseThresholdDb,
            settlingMs: sensor.settlingMs,
            minDurationMs: sensor.minDurationMs,
          });
          aDet.start(stream);
          det = aDet;
        }
        det.onStateChange = (state: SensorState) => {
          sensorStates = { ...sensorStates, [sensor.id]: state };
          _evaluateLinks();
        };
        det.onDetection = (evt) => {
          handleDetectionFired(sensor.id, evt);
        };
        if (sensor.type !== 'audio') det.start();
        activeDetectors.set(sensor.id, det);
      }

      transitionMonitor('active');

      // Start periodic auto-cleanup
      await loadStorageCleanup();
      const cfg = get(storageCleanup);
      if (cfg.autoCleanupEnabled) {
        cleanupTimer = setInterval(async () => {
          const currentCfg = get(storageCleanup);
          if (!currentCfg.autoCleanupEnabled) return;
          const expired = await expirePinnedSegments();
          if (expired > 0) dbg('info', 'idb', `auto-cleanup: expired ${expired} pinned segment(s)`);
          const thinned = await thinSegments(currentCfg.thinningRules);
          if (thinned > 0) dbg('info', 'idb', `auto-cleanup: thinned ${thinned} segment(s)`);
          await evictUnpinned();
        }, cfg.autoCleanupIntervalSec * 1000);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to access camera/mic';
      transitionMonitor('idle');
    }
  }

  async function _ensureStream(sourceId: string): Promise<MediaStream | null> {
    if (openStreams.has(sourceId)) return openStreams.get(sourceId)!;
    // If a concurrent call is already opening this source, return the same promise.
    // Without this, rapid sensor state changes can spawn multiple getDisplayMedia dialogs.
    if (pendingStreams.has(sourceId)) return pendingStreams.get(sourceId)!;

    const src = $sources.find(s => s.id === sourceId);
    if (!src) return null;

    const opening = (async (): Promise<MediaStream | null> => {
      try {
        let stream: MediaStream;
        if (src.type === 'microphone') {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              ...(src.deviceId && { deviceId: { exact: src.deviceId } }),
              ...(src.audioSampleRate && { sampleRate: { ideal: src.audioSampleRate } }),
            },
            video: false,
          });
        } else if (src.type === 'screen') {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: src.frameRate ? { frameRate: { ideal: src.frameRate } } : true,
            audio: true,
          });
          // When the user stops sharing via the browser toolbar, clean up automatically
          for (const track of stream.getTracks()) {
            track.onended = () => {
              if (openStreams.get(sourceId) === stream) {
                openStreams.delete(sourceId);
                openSourceIds = new Set([...openSourceIds].filter(id => id !== sourceId));
                setMonitorStreams(new Map(openStreams));
                dbg('info', 'detector', `screen share ended for source:${sourceId}`);
              }
            };
          }
        } else {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              ...(src.deviceId && { deviceId: { exact: src.deviceId } }),
              ...(src.videoWidth && { width: { ideal: src.videoWidth } }),
              ...(src.videoHeight && { height: { ideal: src.videoHeight } }),
              ...(src.frameRate && { frameRate: { ideal: src.frameRate } }),
            },
            audio: false,
          });
        }
        openStreams.set(sourceId, stream);
        openSourceIds = new Set([...openSourceIds, sourceId]);
        dbg('info', 'detector', `stream opened for source:${sourceId}`);
        return stream;
      } catch (e) {
        dbg('warn', 'detector', `failed to open source:${sourceId} — ${e instanceof Error ? e.message : e}`);
        return null;
      } finally {
        pendingStreams.delete(sourceId);
      }
    })();

    pendingStreams.set(sourceId, opening);
    return opening;
  }

  function _startMeters() {
    if (meterRaf !== null) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    meterCtx?.close();
    meterCtx = null;
    meterAnalysers.clear();

    const micEntries = [...openStreams.entries()].filter(([id, s]) => {
      const src = get(sources).find(sc => sc.id === id);
      return src?.type === 'microphone' && s.getAudioTracks().length > 0;
    });
    if (!micEntries.length) return;

    meterCtx = new AudioContext();
    for (const [id, stream] of micEntries) {
      const analyser = meterCtx.createAnalyser();
      analyser.fftSize = 1024;
      const buf = new Float32Array(analyser.fftSize);
      meterCtx.createMediaStreamSource(stream).connect(analyser);
      meterAnalysers.set(id, { analyser, buf });
    }

    const tick = () => {
      meterRaf = requestAnimationFrame(tick);
      const next = new Map<string, number>();
      for (const [id, { analyser, buf }] of meterAnalysers) {
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        next.set(id, rms > 0 ? 20 * Math.log10(rms) : -Infinity);
      }
      sourceDb = next;
    };
    meterRaf = requestAnimationFrame(tick);
  }

  // ── Link evaluation ───────────────────────────────────────────────────────

  function _evaluateLinks() {
    const now = Date.now();
    const currentSensorStates = sensorStates;
    const allLinks = $links.filter(l => l.enabled);

    for (const link of allLinks) {
      const sState = currentSensorStates[link.sensorId];
      const sensorInTargetState = sState &&
        (link.onState === 'sensing'
          ? (sState.status === 'sensing' || sState.status === 'active')
          : sState.status === 'active');

      if (!sensorInTargetState) {
        // Sensor left the target state — schedule link deactivation after postRollSec
        if (firingLinks.has(link.id) || linkActivationTimers.has(link.id)) {
          _scheduleLinkDeactivation(link.id, link.postRollSec * 1000);
        }
        continue;
      }

      // Sensor is in target state
      if (firingLinks.has(link.id)) continue; // already firing

      if (link.minStateDurationMs <= 0) {
        // Activate immediately
        _cancelLinkDeactivation(link.id);
        _activateLink(link.id, now);
      } else {
        // Check if we already have a waiting timer
        if (!linkActivationTimers.has(link.id)) {
          const startedAt = now;
          const timer = setTimeout(() => {
            linkActivationTimers.delete(link.id);
            if (firingLinks.has(link.id)) return;
            _activateLink(link.id, startedAt);
          }, link.minStateDurationMs);
          linkActivationTimers.set(link.id, timer);
          linkStates = { ...linkStates, [link.id]: { status: 'waiting', startedAt, minMs: link.minStateDurationMs } };
        }
      }
    }

    // Update recorder priority stacks
    const affectedSources = new Set<string>();
    for (const link of allLinks) {
      if (link.captureId) {
        const cap = $captures.find(c => c.id === link.captureId);
        if (cap) affectedSources.add(cap.sourceId);
      }
    }
    for (const sourceId of affectedSources) _updateRecorder(sourceId);
  }

  function _activateLink(linkId: string, startedAt: number) {
    const link = $links.find(l => l.id === linkId);
    if (!link) return;
    firingLinks.add(linkId);
    linkStates = { ...linkStates, [linkId]: { status: 'active', startedAt } };
    dbg('info', 'detector', `link activated: ${link.name}`);
    if (link.captureId) {
      const cap = $captures.find(c => c.id === link.captureId);
      if (cap) _updateRecorder(cap.sourceId);
    }
  }

  function _deactivateLink(linkId: string) {
    if (!firingLinks.has(linkId)) return;
    firingLinks.delete(linkId);
    linkStates = { ...linkStates, [linkId]: { status: 'inactive' } };
    const link = $links.find(l => l.id === linkId);
    dbg('info', 'detector', `link deactivated: ${link?.name ?? linkId}`);
    if (link?.captureId) {
      const cap = $captures.find(c => c.id === link.captureId);
      if (cap) _updateRecorder(cap.sourceId);
    }
    // Close footage session for this link
    const session = footageSessions.get(linkId);
    if (session) {
      if (session.timer) clearTimeout(session.timer);
      footageSessions.delete(linkId);
      syncAlerts();
      _closeFootageSession(session, linkId);
    }
  }

  function _scheduleLinkDeactivation(linkId: string, delayMs: number) {
    _cancelLinkDeactivation(linkId);
    if (delayMs <= 0) {
      _deactivateLink(linkId);
      return;
    }
    const timer = setTimeout(() => {
      linkActivationTimers.delete(linkId);
      _deactivateLink(linkId);
    }, delayMs);
    linkActivationTimers.set(linkId, timer);
  }

  function _cancelLinkDeactivation(linkId: string) {
    const existing = linkActivationTimers.get(linkId);
    if (existing) {
      clearTimeout(existing);
      linkActivationTimers.delete(linkId);
    }
  }

  // ── Per-source recorder priority stack ────────────────────────────────────

  function _bestCaptureForSource(sourceId: string): CaptureMethod | null {
    const allLinks = $links.filter(l => l.enabled && l.captureId && firingLinks.has(l.id));
    const caps = allLinks
      .map(l => $captures.find(c => c.id === l.captureId))
      .filter((c): c is CaptureMethod => c != null && c.sourceId === sourceId && c.type !== 'photo');
    if (!caps.length) return null;
    return caps.sort((a, b) => {
      const pa = 'priority' in a ? a.priority : 0;
      const pb = 'priority' in b ? b.priority : 0;
      return pb - pa;
    })[0];
  }

  async function _updateRecorder(sourceId: string) {
    const best = _bestCaptureForSource(sourceId);
    const slot = recorderSlots.get(sourceId);
    const currentId = slot?.captureId ?? null;
    const newId = best?.id ?? null;

    if (currentId === newId) return; // no change

    // Stop current recorder (will chain to start new one in onstop)
    if (slot?.recorder && slot.recorder.state === 'recording') {
      slot.recorder.stop();
      // onstop will call _startRecorderForSource with the new best
    } else if (best) {
      await _startRecorderForSource(sourceId, best);
    } else {
      // No active captures — clear slot
      recorderSlots.delete(sourceId);
      dbg('info', 'idb', `recording stopped for source:${sourceId}`);
    }
  }

  async function _startRecorderForSource(sourceId: string, cap: CaptureMethod) {
    const stream = await _ensureStream(sourceId);
    if (!stream) return;
    if (cap.type === 'photo') return;

    const mimeType = _selectMimeType(cap);
    const videoBps = cap.type === 'video' ? (cap.videoBitsPerSec > 0 ? cap.videoBitsPerSec : 500_000) : undefined;
    const audioBps = 'audioBitsPerSec' in cap && cap.audioBitsPerSec > 0 ? cap.audioBitsPerSec : 64_000;
    const recordStream = cap.type === 'video' ? stream : new MediaStream(stream.getAudioTracks());
    const segStart = Math.floor(Date.now() / 1000);

    const slot: RecorderSlot = { recorder: null, captureId: cap.id, segmentStart: segStart, chunks: [] };
    recorderSlots.set(sourceId, slot);

    function recordSegment() {
      const currentSlot = recorderSlots.get(sourceId);
      if (!currentSlot || currentSlot.captureId !== cap.id) return;
      const segBegin = currentSlot.segmentStart;
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(recordStream, {
        mimeType,
        ...(videoBps && { videoBitsPerSecond: videoBps }),
        audioBitsPerSecond: audioBps,
      });
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType });
        const segEnd = currentSlot.segmentStart;
        if (blob.size > 0 && $identity) {
          try {
            await saveSegment(blob, mimeType, segBegin, segEnd, $identity.pubkey, sourceId);
            dbg('info', 'idb', `segment saved src:${sourceId} [${segBegin}–${segEnd}] ${blob.size}B`);
          } catch (err) {
            dbg('warn', 'idb', `segment save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Re-evaluate: should we continue with same capture or switch?
        const newBest = _bestCaptureForSource(sourceId);
        if (newBest && get(monitorState) === 'active') {
          if (newBest.id !== cap.id) {
            _startRecorderForSource(sourceId, newBest);
          } else {
            recordSegment();
          }
        } else {
          recorderSlots.delete(sourceId);
        }
      };
      rec.onerror = (e) => dbg('warn', 'idb', `recorder error: ${(e as ErrorEvent).message ?? e}`);
      currentSlot.recorder = rec;
      currentSlot.segmentStart = Math.floor(Date.now() / 1000);
      rec.start();
      dbg('info', 'idb', `recording started src:${sourceId} cap:${cap.name} ${mimeType}`);
      setTimeout(() => {
        if (rec.state === 'recording') {
          currentSlot.segmentStart = Math.floor(Date.now() / 1000);
          rec.stop();
        }
      }, SEGMENT_DURATION_S * 1000);
    }

    recordSegment();
  }

  function _selectMimeType(cap: CaptureMethod): string {
    if (cap.type === 'photo') return 'image/jpeg';
    if (cap.type === 'video') {
      const codec = cap.videoCodec;
      if (codec && MediaRecorder.isTypeSupported(codec)) return codec;
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) return 'video/webm;codecs=vp9,opus';
      return 'video/webm';
    }
    // audio
    const userMime = 'mimeType' in cap ? cap.mimeType : '';
    if (userMime && MediaRecorder.isTypeSupported(userMime)) return userMime;
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    return 'audio/webm';
  }

  // ── Detection handler ─────────────────────────────────────────────────────

  // Called when onDetection fires (sensor confirmed active, event summarized)
  async function handleDetectionFired(
    sensorId: string,
    evt: { type: string; data: Record<string, unknown>; timestamp: number }
  ) {
    if (!$identity) return;

    const sensor = $sensors.find(s => s.id === sensorId);
    const firingLinkList = $links.filter(l => l.enabled && l.sensorId === sensorId && firingLinks.has(l.id));

    for (const link of firingLinkList) {
      const capture = link.captureId ? $captures.find(c => c.id === link.captureId) : null;
      const nostrAction = link.nostrActionId ? $nostrActions.find(a => a.id === link.nostrActionId) : null;
      const sourceId = capture?.sourceId ?? sensor?.sourceId ?? 'default-mic';
      const mimeType = capture ? _mimeForCapture(capture) : 'audio/webm';

      // Manage footage session (FootageRef window)
      if (isStoring(get(monitorState)) && capture && capture.type !== 'photo') {
        await _handleFootageSession(link.id, evt, sourceId, mimeType, link);
      }

      // Photo capture
      if (capture?.type === 'photo') {
        const stream = openStreams.get(capture.sourceId);
        if (stream) {
          const photoLink = link;
          capturePhotosOnTrigger(stream, {
            snapshotCount: link.snapshotCount,
            intervalSec: link.intervalSec,
            imageWidth: capture.imageWidth,
            imageHeight: capture.imageHeight,
            imageQuality: capture.imageQuality,
            imageFormat: capture.imageFormat,
          }, $identity.pubkey, evt.timestamp, capture.sourceId)
            .then(async ids => {
              if (!ids.length) return;
              dbg('info', 'detector', `${ids.length} photo(s) stored for link ${photoLink.name}`);
              if (photoLink.pinLifetimeSec != null) {
                const now = Math.floor(Date.now() / 1000);
                const until = photoLink.pinLifetimeSec === 0 ? 0 : now + photoLink.pinLifetimeSec;
                const spanEnd = evt.timestamp + (photoLink.snapshotCount - 1) * Math.max(photoLink.intervalSec, 1) + 2;
                await pinRange(evt.timestamp, spanEnd, until, 'image/', capture.sourceId);
              }
            })
            .catch(err => dbg('warn', 'detector', `photo error: ${err instanceof Error ? err.message : err}`));
        }
      }

      // Nostr notification
      if (nostrAction && isPublishing(get(monitorState)) && !$settings.pauseNostr) {
        const session = footageSessions.get(link.id);
        const relays = getRelays();
        for (const device of $pairedDevices) {
          const ev = buildTriggerEvent(
            $identity.privkey, $identity.pubkey, device.pubkey,
            evt.type, $settings.selfLabel,
            nostrAction.includeData ? { ...evt.data, sensorName: sensor?.name } : {},
            session?.refId ?? null,
            sourceId,
            nostrAction.messageTemplate,
            nostrAction.includeData,
          );
          const cooldownKey = `trigger:${link.id}:${device.pubkey}`;
          try {
            await publish(ev, { cooldownKey, cooldownMs: nostrAction.cooldownMs });
          } catch (e) {
            const msg = e instanceof Error ? e.message : '';
            if (msg !== 'cooldown') await enqueue(ev, relays);
          }
        }
      }
    }
  }

  function _mimeForCapture(cap: CaptureMethod): string {
    if (cap.type === 'photo') return 'image/jpeg';
    if (cap.type === 'video') return 'video/webm';
    return 'audio/webm';
  }

  async function _handleFootageSession(
    linkId: string,
    evt: { type: string; timestamp: number; data: Record<string, unknown> },
    sourceId: string,
    mimeType: string,
    link: { preRollSec: number; postRollSec: number; onRetrigger: string; pinLifetimeSec: number | null }
  ) {
    if (!$identity) return;
    const durationMs = typeof evt.data.durationMs === 'number' ? evt.data.durationMs : 0;
    const eventEnd = evt.timestamp + Math.ceil(durationMs / 1000);
    const from = evt.timestamp - link.preRollSec;
    const to = eventEnd + link.postRollSec;
    let session = footageSessions.get(linkId);

    if (session && from > session.endTime) {
      if (session.timer) clearTimeout(session.timer);
      await _closeFootageSession(session, linkId);
      session = undefined;
      footageSessions.delete(linkId);
    }

    if (!session) {
      const ref = await createFootageRef({
        originMonitor: $identity.pubkey, triggerType: evt.type, sourceId,
        startTime: from, endTime: to, triggerTime: evt.timestamp,
      });
      session = { refId: ref.refId, startTime: from, endTime: to, mimeType, timer: null };
      footageSessions.set(linkId, session);
      syncAlerts();
      dbg('info', 'idb', `footage session created: ${ref.refId.slice(0, 8)}…`);
    } else if (link.onRetrigger !== 'ignore') {
      const newEnd = Math.max(session.endTime, to);
      if (newEnd > session.endTime) {
        await updateFootageRef(session.refId, { endTime: newEnd });
        session.endTime = newEnd;
        syncAlerts();
      }
    }

    if (session.timer) clearTimeout(session.timer);
    const msUntilClose = Math.max(2000, (session.endTime * 1000 - Date.now()) + 2000);
    const capturedRefId = session.refId;
    session.timer = setTimeout(async () => {
      const s = footageSessions.get(linkId);
      if (!s || s.refId !== capturedRefId) return;
      footageSessions.delete(linkId);
      syncAlerts();
      await _closeFootageSession(s, linkId);
    }, msUntilClose);
  }

  async function _closeFootageSession(
    s: { refId: string; startTime: number; endTime: number; mimeType: string },
    linkId: string
  ) {
    const cfg = get(settings);
    const now = Math.floor(Date.now() / 1000);
    const link = get(links).find(l => l.id === linkId);
    if (link?.pinLifetimeSec != null) {
      const until = link.pinLifetimeSec === 0 ? 0 : now + link.pinLifetimeSec;
      await pinRange(s.startTime, s.endTime, until);
    }
    dbg('info', 'idb', `footage session closed: ${s.refId.slice(0, 8)}… [${s.startTime}–${s.endTime}]`);
    const id = get(identity);
    if (!id || !isPublishing(get(monitorState)) || cfg.pauseNostr) return;
    const source = get(links).find(l => l.id === linkId);
    const cap = source?.captureId ? get(captures).find(c => c.id === source.captureId) : null;
    const sourceId = cap?.sourceId ?? 'default-mic';
    const relays = getRelays();
    for (const device of get(pairedDevices)) {
      const fev = buildFootageRefEvent(
        id.privkey, id.pubkey, device.pubkey,
        s.refId, 'audio', s.startTime, s.endTime, s.startTime + (link?.preRollSec ?? 30),
        sourceId
      );
      try { await publish(fev); } catch { await enqueue(fev, relays); }
    }
  }

  // ── Stop monitor ──────────────────────────────────────────────────────────

  async function stopMonitor() {
    transitionMonitor('stopping');
    if (cleanupTimer !== null) { clearInterval(cleanupTimer); cleanupTimer = null; }
    // Pin and close any open footage sessions before clearing
    for (const [linkId, s] of footageSessions) {
      if (s.timer) clearTimeout(s.timer);
      await _closeFootageSession(s, linkId);
    }
    footageSessions.clear();
    for (const timer of linkActivationTimers.values()) clearTimeout(timer);
    linkActivationTimers.clear();
    firingLinks.clear();
    if (meterRaf !== null) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    meterCtx?.close();
    meterCtx = null;
    meterAnalysers.clear();
    sourceDb = new Map();
    openSourceIds = new Set();
    for (const det of activeDetectors.values()) det.stop();
    activeDetectors.clear();
    for (const slot of recorderSlots.values()) { if (slot.recorder?.state === 'recording') slot.recorder.stop(); }
    recorderSlots.clear();
    for (const stream of openStreams.values()) stream.getTracks().forEach(t => t.stop());
    openStreams.clear();
    pendingStreams.clear();
    setMonitorStream(null);
    stopAllMonitorSessions();
    sensorStates = {};
    linkStates = {};
    activeAlerts = [];
    monitorSnapshot = null;
    transitionMonitor('idle');
  }

  onDestroy(() => {
    stopMonitor();
    stopRouter();
    clearInterval(sessionTick);
    if (cleanupTimer !== null) clearInterval(cleanupTimer);
  });

  const isActive = $derived($monitorState === 'active' || $monitorState === 'starting');

  function dbToPct(db: number): number { return Math.max(0, Math.min(100, (db + 60) * (100 / 60))); }

  function fmtDur(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60), r = s % 60;
    return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
  }

  function _fmtCountdown(sec: number): string {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) {
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      return m ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
    return h ? `${d}d ${h}h` : `${d}d`;
  }

  function sensorBadgeText(st: import('$lib/store/pipeline').SensorState | undefined): string {
    if (!st) return 'INACTIVE';
    if (st.status === 'inactive') return 'INACTIVE';
    if (st.status === 'idle') {
      if (st.nextFireAt) {
        const sec = Math.max(0, Math.ceil((st.nextFireAt - Date.now()) / 1000));
        return `NEXT ${_fmtCountdown(sec)}`;
      }
      return 'IDLE';
    }
    if (st.status === 'sensing') {
      const elapsed = ((Date.now() - st.startedAt) / 1000).toFixed(1);
      return `SENSING ${elapsed}s`;
    }
    if (st.status === 'active') return 'ACTIVE';
    if (st.status === 'settling') {
      const rem = Math.max(0, Math.ceil((st.endsAt - Date.now()) / 1000));
      return `SETTLING ${rem}s`;
    }
    return '—';
  }

  function linkBadgeText(ls: import('$lib/store/pipeline').LinkActivationState | undefined): string {
    if (!ls || ls.status === 'inactive') return 'INACTIVE';
    if (ls.status === 'waiting') {
      const elapsed = ((Date.now() - ls.startedAt) / 1000).toFixed(1);
      const total = (ls.minMs / 1000).toFixed(1);
      return `WAIT ${elapsed}/${total}s`;
    }
    return 'ACTIVE';
  }

  const statusBadge = $derived(
    $monitorState === 'starting'  ? { label: 'STARTING',        color: 'var(--color-warning)' }
    : $monitorState === 'stopping'? { label: 'STOPPING',        color: 'var(--color-warning)' }
    : isActive                    ? { label: 'RUNNING',         color: 'var(--color-success)' }
    : sessions.some(s => s.iceState === 'connected' || s.iceState === 'completed')
                                  ? { label: 'CONNECTED',       color: 'var(--color-accent)'  }
    : signalRouterActive && autoAccept
                                  ? { label: 'LISTENING · AUTO',color: 'var(--color-warning)' }
    : signalRouterActive          ? { label: 'LISTENING',       color: 'var(--color-warning)' }
                                  : { label: 'IDLE',            color: 'var(--color-border)'  }
  );

  // Wire up detection callbacks after detectors start
  function _wireDetection() {
    for (const [sensorId, det] of activeDetectors.entries()) {
      det.onDetection = (evt: DetectionEvent<Record<string, unknown>>) => handleDetectionFired(sensorId, evt);
    }
  }
  $effect(() => { if (isActive) _wireDetection(); });
</script>

<DevSection title="Sentry" badge={statusBadge.label} badgeColor={statusBadge.color}>
  {#snippet actions()}
    <button class="act-btn" onclick={() => (showRaw = !showRaw)}>{showRaw ? 'Hide' : 'View'} Raw</button>
  {/snippet}

  <!-- ── Monitor ──────────────────────────────────────────────────────────── -->
  {#if isActive}
    <button class="monitor-btn stop" onclick={stopMonitor}>Stop Monitor</button>
  {:else}
    <button class="monitor-btn start" onclick={startMonitor}
      disabled={$monitorState === 'starting' || $monitorState === 'stopping'}>
      {$monitorState === 'starting' ? 'Starting…' : $monitorState === 'stopping' ? 'Stopping…' : 'Start Monitor'}
    </button>
  {/if}

  {#if error}
    <div class="err-msg">{error}</div>
  {/if}

  {#if showRaw}
    <pre class="raw">{JSON.stringify(monitorSnapshot ?? { settings: $settings, sources: $sources, sensors: $sensors, captures: $captures, links: $links }, null, 2)}</pre>
  {/if}

  <!-- Video preview (camera / screen sources) -->
  <video bind:this={videoEl} autoplay muted playsinline class="camera-preview"
    class:hidden={!isActive || !$sources.some(s => openSourceIds.has(s.id) && (s.type === 'camera' || s.type === 'screen'))}></video>

  <!-- Pipeline status — Sources / Sensors / Links (while running) -->
  {#if isActive}
    <div class="pipeline-status">

      <div class="ps-header">Sources</div>
      {#each $sources.filter(s => openSourceIds.has(s.id)) as src (src.id)}
        <div class="ps-row">
          <span class="ps-badge {src.type === 'microphone' ? 'mic' : src.type === 'camera' ? 'cam' : 'screen'}">
            {src.type === 'microphone' ? 'MIC' : src.type === 'camera' ? 'CAM' : 'SCRN'}
          </span>
          <span class="ps-name">{src.name}</span>
          {#if src.type === 'microphone'}
            {@const db = sourceDb.get(src.id) ?? -Infinity}
            {@const pct = dbToPct(db)}
            {@const thresh = $sensors.find(s => s.enabled && s.sourceId === src.id && s.type === 'audio')?.thresholdDb}
            {@const threshPct = thresh != null ? dbToPct(thresh) : null}
            {@const hot = isFinite(db) && thresh != null && db > thresh}
            <div class="ps-meter-track">
              <div class="ps-meter-fill" style="width:{pct}%;background:{hot ? 'var(--color-danger)' : 'var(--color-success)'}"></div>
              {#if threshPct !== null}<div class="ps-meter-thresh" style="left:{threshPct}%"></div>{/if}
            </div>
            <span class="ps-db">{isFinite(db) ? db.toFixed(1) + ' dB' : '—'}</span>
          {:else}
            <span class="ps-live">● live</span>
          {/if}
        </div>
      {/each}
      {#if $sources.filter(s => openSourceIds.has(s.id)).length === 0}
        <div class="ps-empty">No streams open</div>
      {/if}

      <div class="ps-header">Sensors</div>
      {#each $sensors.filter(s => s.enabled) as sensor (sensor.id)}
        {@const st = sensorStates[sensor.id]}
        <div class="ps-row">
          <span class="ps-badge {sensor.type === 'schedule' || sensor.type === 'timewindow' || sensor.type === 'daterange' ? 'sched' : 'audio'}">{sensor.type === 'schedule' ? 'SCHED' : sensor.type === 'timewindow' ? 'TIME' : sensor.type === 'daterange' ? 'DATE' : 'AUDIO'}</span>
          <span class="ps-name">{sensor.name}</span>
          <span class="ps-state {st?.status ?? 'inactive'}">{sensorBadgeText(st)}</span>
        </div>
      {/each}
      {#if $sensors.filter(s => s.enabled).length === 0}
        <div class="ps-empty">No enabled sensors</div>
      {/if}

      <div class="ps-header">Links</div>
      {#each $links.filter(l => l.enabled) as link (link.id)}
        {@const ls = linkStates[link.id]}
        {@const session = activeAlerts.find(a => a.linkId === link.id)}
        {@const cap = link.captureId ? $captures.find(c => c.id === link.captureId) : null}
        <div class="ps-row">
          <span class="ps-badge link">LINK</span>
          <span class="ps-name">{link.name}</span>
          <span class="ps-state {ls?.status ?? 'inactive'}">{linkBadgeText(ls)}</span>
          {#if session}
            <span class="ps-session">{cap?.type === 'photo' ? '[photo]' : '[rec]'} {fmtDur(Math.floor(Date.now() / 1000) - session.startTime)}</span>
          {/if}
        </div>
      {/each}
      {#if $links.filter(l => l.enabled).length === 0}
        <div class="ps-empty">No enabled links</div>
      {/if}

    </div>
  {/if}

  <!-- ── Remote Viewing ──────────────────────────────────────────────────── -->
  <div class="rtc-section">
    <div class="rtc-section-title">Remote Viewing</div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-lbl">Accept viewer connections</span>
        <span class="setting-desc">Listen for incoming WebRTC requests via Nostr</span>
      </div>
      <button class="setting-toggle" aria-pressed={signalRouterActive}
        style="background:{signalRouterActive ? 'var(--color-accent)' : 'var(--color-border)'}"
        onclick={() => signalRouterActive ? stopRouter() : startRouter()}>
        <span class="toggle-thumb" style="transform:translateX({signalRouterActive ? '14px' : '2px'})"></span>
      </button>
    </div>

    {#if signalRouterActive}
    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-lbl">Auto-accept requests</span>
        <span class="setting-desc">Approve without manual confirmation</span>
      </div>
      <button class="setting-toggle" aria-pressed={autoAccept}
        style="background:{autoAccept ? 'var(--color-success)' : 'var(--color-border)'}"
        onclick={() => (autoAccept = !autoAccept)}>
        <span class="toggle-thumb" style="transform:translateX({autoAccept ? '14px' : '2px'})"></span>
      </button>
    </div>
    {/if}

    {#if sessions.length > 0}
      <div class="sessions-header">
        <span>{sessions.length} viewer{sessions.length !== 1 ? 's' : ''} connected</span>
        <button class="act-btn danger" onclick={() => { stopAllMonitorSessions(); sessions = []; }}>Disconnect all</button>
      </div>
      {#each sessions as sess (sess.viewerPubkey)}
        {@const nick = $pairedDevices.find(d => d.pubkey === sess.viewerPubkey)?.nickname ?? sess.viewerPubkey.slice(0, 10) + '…'}
        <div class="session-row">
          <span class="sess-nick">{nick}</span>
          <span class="sess-chip {sess.iceState === 'connected' || sess.iceState === 'completed' ? 'good' : 'dim'}">{sess.iceState}</span>
          <span class="sess-chip dim">{sess.trackCount} tracks</span>
          <button class="act-btn" onclick={() => (showPreview[sess.viewerPubkey] = !showPreview[sess.viewerPubkey])}>
            {showPreview[sess.viewerPubkey] ? 'Hide' : 'Preview'}
          </button>
        </div>
        {#if showPreview[sess.viewerPubkey]}
          {@const stream = [...openStreams.values()].find(s => s.getVideoTracks().length > 0) ?? [...openStreams.values()][0]}
          {#if stream}
            <video class="rtc-preview" autoplay muted playsinline srcObject={stream}></video>
          {/if}
        {/if}
      {/each}
    {/if}
  </div>

  <LogPanel sources={['rtc', 'detector']} />
</DevSection>

<style>
  /* ── Shared small action button ─────────────────────────────────────────── */
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }

  /* ── Monitor start/stop ─────────────────────────────────────────────────── */
  .monitor-btn { width: 100%; padding: 8px 0; border-radius: 6px; border: none; font-size: 13px; font-weight: 700; font-family: inherit; cursor: pointer; letter-spacing: 0.03em; transition: opacity 0.15s; }
  .monitor-btn:disabled { opacity: 0.5; cursor: default; }
  .monitor-btn.start { background: var(--color-success); color: white; }
  .monitor-btn.stop  { background: transparent; color: var(--color-danger); border: 1px solid var(--color-danger); }
  .monitor-btn.start:hover:not(:disabled) { opacity: 0.88; }
  .monitor-btn.stop:hover:not(:disabled)  { background: rgba(239,68,68,0.08); }

  .err-msg { font-size: 11px; color: var(--color-danger); padding: 4px 8px; background: rgba(239,68,68,0.1); border-radius: 4px; }
  .camera-preview { width: 100%; border-radius: 8px; background: #000; max-height: 220px; }
  .camera-preview.hidden { display: none; }

  /* Pipeline status panel */
  .pipeline-status { display: flex; flex-direction: column; gap: 3px; }
  .ps-header { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 6px; }
  .ps-row { display: flex; align-items: center; gap: 6px; min-height: 22px; }
  .ps-empty { font-size: 10px; color: var(--color-muted); font-style: italic; padding-left: 2px; }
  .ps-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0; color: white; }
  .ps-badge.mic    { background: #2563eb; }
  .ps-badge.cam    { background: #7c3aed; }
  .ps-badge.screen { background: #0e7490; }
  .ps-badge.audio  { background: #2563eb; }
  .ps-badge.sched  { background: #0891b2; }
  .ps-badge.link   { background: #d97706; }
  .ps-name { font-size: 11px; color: var(--color-text); min-width: 80px; flex-shrink: 0; }
  .ps-meter-track { flex: 1; height: 8px; border-radius: 4px; background: var(--color-surface); overflow: visible; position: relative; }
  .ps-meter-fill { height: 100%; border-radius: 4px; transition: width 0.075s; }
  .ps-meter-thresh { position: absolute; top: -2px; bottom: -2px; width: 2px; border-radius: 1px; background: rgba(255,255,255,0.5); pointer-events: none; }
  .ps-db { font-size: 10px; color: var(--color-muted); font-family: ui-monospace, monospace; width: 60px; text-align: right; flex-shrink: 0; }
  .ps-live { font-size: 10px; color: var(--color-success); font-weight: 600; }
  .ps-state { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
  .ps-state.inactive { background: var(--color-border); color: var(--color-muted); }
  .ps-state.idle     { background: var(--color-border); color: var(--color-muted); }
  .ps-state.sensing  { background: #1d4ed8; color: white; }
  .ps-state.active   { background: var(--color-success); color: white; }
  .ps-state.settling { background: var(--color-warning); color: #1a1a1a; }
  .ps-state.waiting  { background: #92400e; color: #fcd34d; }
  .ps-session { font-size: 10px; color: var(--color-danger); font-family: ui-monospace, monospace; font-weight: 600; }

  /* ── Remote Viewing section ─────────────────────────────────────────────── */
  .rtc-section { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
  .rtc-section-title { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--color-muted); margin-bottom: 4px; }

  .setting-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--color-border); }
  .setting-row:last-child { border-bottom: none; }
  .setting-info { flex: 1; display: flex; flex-direction: column; gap: 1px; }
  .setting-lbl  { font-size: 11px; color: var(--color-text); font-weight: 500; }
  .setting-desc { font-size: 10px; color: var(--color-muted); }
  .setting-toggle { width: 28px; height: 16px; border-radius: 8px; border: none; padding: 0; cursor: pointer; position: relative; flex-shrink: 0; transition: background 0.15s; }
  .toggle-thumb { position: absolute; top: 2px; left: 0; width: 12px; height: 12px; border-radius: 50%; background: white; transition: transform 0.15s; }

  .sessions-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 0 2px; font-size: 11px; color: var(--color-muted); }
  .session-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; background: var(--color-surface); font-size: 11px; flex-wrap: wrap; margin-bottom: 2px; }
  .sess-nick { font-weight: 600; color: var(--color-text); flex: 1; min-width: 60px; }
  .sess-chip { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
  .sess-chip.good { background: var(--color-success); color: white; }
  .sess-chip.dim  { background: var(--color-border); color: var(--color-muted); }
  .rtc-preview { width: 100%; border-radius: 6px; background: #000; max-height: 160px; margin-top: 2px; }

  .raw { font-size: 10px; font-family: ui-monospace, monospace; background: #09090b; padding: 10px; border-radius: 6px; overflow: auto; max-height: 300px; color: #a3e635; margin: 0; }
</style>
