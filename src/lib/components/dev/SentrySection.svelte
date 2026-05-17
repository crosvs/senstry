<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { identity, pairedDevices } from '$lib/store/identity';
  import { settings } from '$lib/store/settings';
  import {
    sources, sensors, captures, actions, channels, links, loadPipeline,
    storageCleanup, loadStorageCleanup,
    autoNameSensor, autoNameAction, autoNameLink,
    type SensorState, type ActionState, type Action, type RecordAction, type ClipAction,
    type SnapshotAction, type NotifyAction, type CaptureMethod, type ChannelConfig,
  } from '$lib/store/pipeline';
  import { AudioDetector } from '$lib/detectors/audio';
  import { ScheduleDetector } from '$lib/detectors/schedule';
  import { TimeWindowDetector } from '$lib/detectors/timewindow';
  import { DateRangeDetector } from '$lib/detectors/daterange';
  import { NostrTriggerDetector } from '$lib/detectors/nostr-trigger';
  import type { DetectionEvent } from '$lib/detectors/types';
  import { capturePhotosOnTrigger } from '$lib/detectors/photo';
  import { saveSegment, pinRange, thinSegments, evictUnpinned, expirePinnedSegments, setMonitorRollingBuffer, SEGMENT_DURATION_S } from '$lib/db/segments';
  import { createFootageRef, updateFootageRef } from '$lib/db/footage';
  import { getPhotosInRange, pinPhoto } from '$lib/db/photos';
  import { buildTriggerEvent, buildFootageRefEvent, KIND_TRIGGER } from '$lib/nostr/events';
  import { publish, getRelays, subscribe } from '$lib/nostr/client';
  import { decrypt } from '$lib/nostr/crypto';
  import { enqueue } from '$lib/db/outbox';
  import {
    setMonitorStream, setMonitorStreams, setMonitorChannels, setChannelActiveSources,
    setIdleTimeout, handleOfferRequest,
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
    actionId: string;
    actionName: string;
    channelId: string;
    startTime: number;
    endTime: number;
    mimeType: string;
  };

  // ── Props ─────────────────────────────────────────────────────────────────

  interface Props {
    signalRouterActive?: boolean;
    autoAccept?: boolean;
    sensorStates?: Record<string, SensorState>;
    actionStates?: Record<string, ActionState>;
    activeAlerts?: AlertSession[];
    onPendingOffer?: (fromPubkey: string, msg: SignalMessage) => void;
    acceptOffer?: { fromPubkey: string; msg: SignalMessage } | null;
  }
  let {
    signalRouterActive = $bindable(false),
    autoAccept = $bindable(true),
    sensorStates = $bindable<Record<string, SensorState>>({}),
    actionStates = $bindable<Record<string, ActionState>>({}),
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
  let openSourceIds = $state(new Set<string>());
  let sourceDb = $state(new Map<string, number>());
  let meterRaf: number | null = null;
  let meterCtx: AudioContext | null = null;
  const meterAnalysers = new Map<string, { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> }>();
  let videoEl: HTMLVideoElement | undefined = $state();

  // ── Multi-source execution state ──────────────────────────────────────────

  const openStreams = new Map<string, MediaStream>();
  const pendingStreams = new Map<string, Promise<MediaStream | null>>();

  interface SensorDetector {
    start?(stream?: MediaStream): void;
    stop(): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onDetection: ((event: DetectionEvent<any>) => void) | null;
    onStateChange: ((state: SensorState) => void) | null;
  }
  const activeDetectors = new Map<string, SensorDetector>();
  const nostrTriggerSubs = new Map<string, { close: () => void }>();

  // Channel recorder slots keyed by `${channelId}::${captureType}`
  interface ChannelRecorderSlot {
    recorder: MediaRecorder | null;
    captureId: string | null;
    segmentStart: number;
    chunks: Blob[];
  }
  const channelRecorders = new Map<string, ChannelRecorderSlot>();
  const _recKey = (channelId: string, captureType: 'video' | 'audio') => `${channelId}::${captureType}`;

  // Per-action deactivation timers (post-roll)
  const actionDeactivationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // NotifyAction cooldown tracking: key → cooldown expiry (unix ms)
  const notifyCooldowns = new Map<string, number>();

  // Interval handles for infinite snapshot bursts (snapshotCount === 0)
  const snapshotIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Footage session accumulator per ClipAction
  interface FootageSession {
    refId: string;
    startTime: number;
    endTime: number;
    mimeType: string;
    triggerType: string;
    channelId: string;
    timer: ReturnType<typeof setTimeout> | null;
  }
  const footageSessions = new Map<string, FootageSession>();

  function syncAlerts() {
    activeAlerts = [...footageSessions.entries()].map(([actionId, s]) => {
      const action = get(actions).find(a => a.id === actionId);
      return {
        actionId, actionName: action?.name ?? actionId,
        channelId: s.channelId,
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
      actions: $actions, channels: $channels, links: $links,
    }};
    await navigator.storage?.persist().catch(() => {});

    try {
      // Enabled RecordActions: those with at least one enabled link
      const enabledRecordActions = ($actions.filter((a): a is RecordAction => a.type === 'record'))
        .filter(a => $links.some(l => l.enabled && l.actionIds.includes(a.id)));

      // Rolling buffer: max across enabled RecordActions (null = infinite wins)
      const effectiveRollingBuffer = enabledRecordActions.reduce<number | null>(
        (acc, a) => (acc === null || a.rollingBufferSec === null) ? null : Math.max(acc, a.rollingBufferSec),
        0
      );
      setMonitorRollingBuffer(effectiveRollingBuffer === 0 ? null : effectiveRollingBuffer);

      // Collect needed source IDs
      const neededSourceIds = new Set<string>();
      for (const sensor of $sensors.filter(s => s.enabled && s.type === 'audio')) {
        neededSourceIds.add(sensor.sourceId);
      }
      for (const action of enabledRecordActions) {
        const ch = $channels.find(c => c.id === action.channelId);
        if (!ch) continue;
        if (ch.videoSourceId) neededSourceIds.add(ch.videoSourceId);
        if (ch.audioSourceId) neededSourceIds.add(ch.audioSourceId);
      }
      const enabledSnapActions = ($actions.filter((a): a is SnapshotAction => a.type === 'snapshot'))
        .filter(a => $links.some(l => l.enabled && l.actionIds.includes(a.id)));
      for (const action of enabledSnapActions) {
        if (action.captureId) {
          const cap = $captures.find(c => c.id === action.captureId);
          if (cap?.sourceId) neededSourceIds.add(cap.sourceId);
        }
      }

      for (const sourceId of neededSourceIds) {
        if (sourceId && sourceId !== 'none') await _ensureStream(sourceId);
      }

      setMonitorStreams(new Map(openStreams));
      setMonitorChannels(get(channels));
      const videoEntry = [...openStreams.entries()].find(([id]) =>
        $sources.find(s => s.id === id && (s.type === 'camera' || s.type === 'screen'))
      );
      const previewStream = videoEntry?.[1] ?? openStreams.get('default-mic') ?? [...openStreams.values()][0] ?? null;
      if (videoEl && previewStream) videoEl.srcObject = previewStream;
      setIdleTimeout($settings.rtcIdleTimeoutMs);

      _startMeters();

      // Start always-on recording for each (channelId, captureType) pair from enabled RecordActions
      const channelCapturePairs = new Set<string>();
      for (const action of enabledRecordActions) {
        for (const capId of action.captureIds) {
          const cap = $captures.find(c => c.id === capId);
          if (cap && cap.type !== 'photo') channelCapturePairs.add(_recKey(action.channelId, cap.type as 'video' | 'audio'));
        }
      }
      for (const key of channelCapturePairs) {
        const [channelId, captureType] = key.split('::') as [string, 'video' | 'audio'];
        _updateChannelRecorder(channelId, captureType);
      }

      // Start sensors
      for (const sensor of $sensors.filter(s => s.enabled)) {
        let det: SensorDetector;
        if (sensor.type === 'schedule') {
          det = new ScheduleDetector({ intervalMs: sensor.intervalMs, settlingMs: sensor.settlingMs });
        } else if (sensor.type === 'timewindow') {
          det = new TimeWindowDetector({ activeSlots: sensor.activeSlots ?? [] });
        } else if (sensor.type === 'daterange') {
          det = new DateRangeDetector({ startIso: sensor.startIso, endIso: sensor.endIso });
        } else if (sensor.type === 'nostr-trigger') {
          if (!sensor.monitorPubkey) continue;
          const ntDet = new NostrTriggerDetector({
            minDurationMs: sensor.minDurationMs,
            settlingMs: sensor.settlingMs,
          });
          const capturedSensor = sensor;
          const ntSub = subscribe(
            {
              kinds: [KIND_TRIGGER],
              '#p': [$identity.pubkey],
              since: Math.floor(Date.now() / 1000) - 30,
            },
            (event) => {
              if (event.pubkey !== capturedSensor.monitorPubkey) return;
              const id = get(identity);
              if (!id) return;
              let payload: Record<string, unknown>;
              try {
                const plain = decrypt(id.privkey, event.pubkey, event.content);
                payload = JSON.parse(plain);
              } catch { return; }

              const remoteState = payload.sensorState as 'sensing' | 'active' | 'idle';
              if (!remoteState) return;
              if (capturedSensor.nostrChannelId && payload.channelId !== capturedSensor.nostrChannelId) return;
              if (capturedSensor.detectionTypes?.length) {
                if (!capturedSensor.detectionTypes.includes(payload.type as string)) return;
              }

              const timing = (payload.sensorTiming as { minDurationMs: number; settlingMs: number }) ?? { minDurationMs: 0, settlingMs: 0 };
              ntDet.handleRemoteState(
                remoteState,
                {
                  monitorPubkey: event.pubkey,
                  channelId: (payload.channelId as string | null) ?? null,
                  detectionType: (payload.type as string) || 'nostr-trigger',
                },
                timing
              );
            }
          );
          nostrTriggerSubs.set(sensor.id, ntSub);
          det = ntDet;
        } else {
          // audio
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

        const capturedSensor = sensor;
        det.onStateChange = (state: SensorState) => {
          sensorStates = { ...sensorStates, [capturedSensor.id]: state };
          _evaluateLinks();
          _handleSensorStateForNotify(capturedSensor.id, state);
        };
        det.onDetection = (evt) => {
          handleDetectionFired(capturedSensor.id, evt);
        };
        if (sensor.type !== 'audio' && sensor.type !== 'nostr-trigger') det.start?.();
        activeDetectors.set(sensor.id, det);
      }

      transitionMonitor('active');

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

    const audioEntries = [...openStreams.entries()].filter(([id, s]) => {
      const src = get(sources).find(sc => sc.id === id);
      return (src?.type === 'microphone' || src?.type === 'screen') && s.getAudioTracks().length > 0;
    });
    if (!audioEntries.length) return;

    meterCtx = new AudioContext();
    for (const [id, stream] of audioEntries) {
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
    // Build map: actionId -> whether any enabled link has its condition met
    const actionShouldFire = new Map<string, boolean>();
    for (const link of $links.filter(l => l.enabled)) {
      const condMet = _linkConditionMet(link);
      for (const actionId of link.actionIds) {
        if (condMet) {
          actionShouldFire.set(actionId, true);
        } else if (!actionShouldFire.has(actionId)) {
          actionShouldFire.set(actionId, false);
        }
      }
    }

    for (const [actionId, shouldFire] of actionShouldFire) {
      const action = $actions.find(a => a.id === actionId);
      if (!action || action.type === 'notify') continue;

      const isActive = actionStates[actionId]?.status === 'active';
      const pendingDeact = actionDeactivationTimers.has(actionId);

      if (shouldFire) {
        _cancelActionDeactivation(actionId);
        if (!isActive) {
          _activateAction(action);
        } else if ((action as RecordAction | ClipAction).onRetrigger === 'restart') {
          _deactivateActionNow(action);
          _activateAction(action);
        }
        // 'extend': deactivation cancelled above, nothing more
        // 'ignore': already active, do nothing
      } else if (isActive && !pendingDeact) {
        _scheduleActionDeactivation(action);
      }
    }

    // Update channel recorders for all RecordActions with enabled links
    const channelCaptureKeys = new Set<string>();
    for (const action of $actions.filter((a): a is RecordAction =>
      a.type === 'record' && $links.some(l => l.enabled && l.actionIds.includes(a.id))
    )) {
      for (const capId of action.captureIds) {
        const cap = $captures.find(c => c.id === capId);
        if (cap && cap.type !== 'photo') channelCaptureKeys.add(_recKey(action.channelId, cap.type as 'video' | 'audio'));
      }
    }
    for (const key of channelCaptureKeys) {
      const [channelId, captureType] = key.split('::') as [string, 'video' | 'audio'];
      _updateChannelRecorder(channelId, captureType);
    }
  }

  function _linkConditionMet(link: import('$lib/store/pipeline').Link): boolean {
    const results = link.sensorIds.map(id => {
      const s = sensorStates[id];
      if (!s) return false;
      return link.onState === 'sensing'
        ? s.status === 'sensing' || s.status === 'active'
        : s.status === 'active';
    });
    return link.condition === 'all' ? results.every(Boolean) : results.some(Boolean);
  }

  function _activateAction(action: Action) {
    const now = Date.now();
    actionStates = { ...actionStates, [action.id]: { status: 'active', startedAt: now } };
    dbg('info', 'detector', `action activated: ${action.name || action.type} (${action.id.slice(0, 8)})`);
    if (action.type === 'record') {
      for (const capId of action.captureIds) {
        const cap = $captures.find(c => c.id === capId);
        if (cap && cap.type !== 'photo') _updateChannelRecorder(action.channelId, cap.type as 'video' | 'audio');
      }
      _updateChannelActiveSources();
    }
    if (action.type === 'snapshot' && action.snapshotCount === 0) {
      _startInfiniteSnapshotInterval(action);
    }
  }

  function _deactivateActionNow(action: Action) {
    _cancelActionDeactivation(action.id);
    actionStates = { ...actionStates, [action.id]: { status: 'idle' } };
    dbg('info', 'detector', `action deactivated: ${action.name || action.type}`);
    if (action.type === 'record') {
      for (const capId of action.captureIds) {
        const cap = $captures.find(c => c.id === capId);
        if (cap && cap.type !== 'photo') _updateChannelRecorder(action.channelId, cap.type as 'video' | 'audio');
      }
      _updateChannelActiveSources();
    }
    if (action.type === 'snapshot') {
      _stopSnapshotInterval(action.id);
    }
    if (action.type === 'clip') {
      const session = footageSessions.get(action.id);
      if (session) {
        if (session.timer) clearTimeout(session.timer);
        footageSessions.delete(action.id);
        syncAlerts();
        _closeFootageSession(session, action.id, action);
      }
    }
  }

  function _scheduleActionDeactivation(action: Action) {
    _cancelActionDeactivation(action.id);
    const postRollMs = (action.type === 'record' || action.type === 'clip') ? action.postRollSec * 1000 : 0;
    if (postRollMs <= 0) {
      _deactivateActionNow(action);
      return;
    }
    const timer = setTimeout(() => {
      actionDeactivationTimers.delete(action.id);
      _deactivateActionNow(action);
    }, postRollMs);
    actionDeactivationTimers.set(action.id, timer);
  }

  function _cancelActionDeactivation(actionId: string) {
    const existing = actionDeactivationTimers.get(actionId);
    if (existing) { clearTimeout(existing); actionDeactivationTimers.delete(actionId); }
  }

  // ── Infinite snapshot interval ────────────────────────────────────────────

  function _startInfiniteSnapshotInterval(action: SnapshotAction) {
    _stopSnapshotInterval(action.id);
    const cap = $captures.find(c => c.id === action.captureId);
    if (cap?.type !== 'photo') return;

    const fireSnapshot = () => {
      const stream = openStreams.get(cap.sourceId);
      const id = get(identity);
      if (!stream || !id) return;
      capturePhotosOnTrigger(stream, {
        snapshotCount: 1, intervalSec: 0,
        imageWidth: cap.imageWidth, imageHeight: cap.imageHeight,
        imageQuality: cap.imageQuality, imageFormat: cap.imageFormat,
      }, id.pubkey, Math.floor(Date.now() / 1000), action.channelId)
        .then(async ids => {
          if (!ids.length || action.pinLifetimeSec == null) return;
          const now = Math.floor(Date.now() / 1000);
          const until = action.pinLifetimeSec === 0 ? 0 : now + action.pinLifetimeSec;
          await pinRange(now - 2, now + 2, until, 'image/', action.channelId);
        })
        .catch(err => dbg('warn', 'detector', `snapshot error: ${err instanceof Error ? err.message : err}`));
    };

    fireSnapshot(); // immediate first shot
    const interval = setInterval(fireSnapshot, Math.max(500, action.intervalSec * 1000));
    snapshotIntervals.set(action.id, interval);
  }

  function _stopSnapshotInterval(actionId: string) {
    const iv = snapshotIntervals.get(actionId);
    if (iv !== undefined) { clearInterval(iv); snapshotIntervals.delete(actionId); }
  }

  // ── NotifyAction: publish on sensor state transitions ─────────────────────

  async function _handleSensorStateForNotify(sensorId: string, state: SensorState) {
    const id = get(identity);
    if (!id || !isPublishing(get(monitorState)) || get(settings).pauseNostr) return;

    const sensorState: 'sensing' | 'active' | 'idle' =
      state.status === 'sensing' ? 'sensing'
      : state.status === 'active' ? 'active'
      : 'idle';

    const sensor = get(sensors).find(s => s.id === sensorId);
    const notifyActions = $links
      .filter(l => l.enabled && l.sensorIds.includes(sensorId))
      .flatMap(l => l.actionIds.map(id => $actions.find(a => a.id === id)))
      .filter((a): a is NotifyAction => a?.type === 'notify');

    if (!notifyActions.length) return;

    const sensorTiming = { minDurationMs: sensor?.minDurationMs ?? 0, settlingMs: sensor?.settlingMs ?? 0 };
    const detectionType = sensor?.type === 'audio' ? 'audio'
      : sensor?.type === 'schedule' ? 'schedule'
      : sensor?.type === 'timewindow' ? 'timewindow'
      : sensor?.type === 'daterange' ? 'daterange'
      : 'nostr-trigger';

    // Find a channelId from any linked RecordAction or ClipAction on the same sensor
    const channelId: string | null = (() => {
      const linked = $links
        .filter(l => l.enabled && l.sensorIds.includes(sensorId))
        .flatMap(l => l.actionIds.map(id => $actions.find(a => a.id === id)))
        .find((a): a is RecordAction | ClipAction => a?.type === 'record' || a?.type === 'clip');
      return linked?.channelId ?? null;
    })();

    for (const action of notifyActions) {
      if (!action.publishStates.includes(sensorState)) continue;

      // Attach footageRefId from any active ClipAction session on same sensor
      let footageRefId: string | null = null;
      if (sensorState === 'active') {
        const clipActions = $links
          .filter(l => l.enabled && l.sensorIds.includes(sensorId))
          .flatMap(l => l.actionIds.map(id => $actions.find(a => a.id === id)))
          .filter((a): a is ClipAction => a?.type === 'clip');
        for (const ca of clipActions) {
          const s = footageSessions.get(ca.id);
          if (s) { footageRefId = s.refId; break; }
        }
      }

      const relays = getRelays();
      const allDevices = get(pairedDevices);
      const targets = action.viewerPubkey
        ? allDevices.filter(d => d.pubkey === action.viewerPubkey)
        : allDevices;

      for (const device of targets) {
        const cdKey = `${action.id}:${device.pubkey}`;
        const cdEndsAt = notifyCooldowns.get(cdKey) ?? 0;
        const inCooldown = Date.now() < cdEndsAt;

        if (action.onRetrigger === 'ignore' && inCooldown) continue;
        if (action.onRetrigger === 'extend') {
          // Push cooldown window forward; only send if we weren't already in cooldown
          notifyCooldowns.set(cdKey, Date.now() + action.cooldownMs);
          if (inCooldown) continue;
        } else {
          // 'ignore' (not in cooldown) or 'restart': always send, reset cooldown
          notifyCooldowns.set(cdKey, Date.now() + action.cooldownMs);
        }

        const ev = buildTriggerEvent(
          id.privkey, id.pubkey, device.pubkey,
          detectionType, sensorState,
          get(settings).selfLabel,
          {}, footageRefId, channelId, sensorTiming,
          action.messageTemplate, false,
        );
        try {
          await publish(ev);
        } catch (e) {
          await enqueue(ev, relays);
        }
      }
    }
  }

  // ── Channel active source tracking (for live RTC) ────────────────────────

  function _updateChannelActiveSources() {
    const overrides = new Map<string, { videoSourceId?: string | null; audioSourceId?: string | null }>();
    for (const ch of $channels) {
      const best = ($actions.filter((a): a is RecordAction => a.type === 'record' && a.channelId === ch.id))
        .filter(a => actionStates[a.id]?.status === 'active')
        .sort((a, b) => b.priority - a.priority)[0];
      if (best) {
        let videoSourceId: string | null = null;
        let audioSourceId: string | null = null;
        for (const capId of best.captureIds) {
          const cap = $captures.find(c => c.id === capId);
          if (!cap) continue;
          if (cap.type === 'video' && !videoSourceId) videoSourceId = cap.sourceId;
          if (cap.type === 'audio' && !audioSourceId) audioSourceId = cap.sourceId;
        }
        overrides.set(ch.id, { videoSourceId, audioSourceId });
      }
    }
    setChannelActiveSources(overrides);
  }

  // ── Channel recorder priority stack ──────────────────────────────────────

  function _bestCaptureForChannel(channelId: string, captureType: 'video' | 'audio'): CaptureMethod | null {
    const eligible = ($actions.filter((a): a is RecordAction => a.type === 'record' && a.channelId === channelId))
      .filter(a => $links.some(l => l.enabled && l.actionIds.includes(a.id)))
      .flatMap(a => a.captureIds.map(capId => ({ action: a, cap: $captures.find(c => c.id === capId) })))
      .filter((e): e is { action: RecordAction; cap: CaptureMethod } =>
        e.cap != null && e.cap.type === captureType
      );

    if (!eligible.length) return null;

    const active = eligible.filter(e => actionStates[e.action.id]?.status === 'active');
    if (active.length) return active.sort((a, b) => b.action.priority - a.action.priority)[0].cap;
    return eligible.sort((a, b) => a.action.priority - b.action.priority)[0].cap;
  }

  async function _updateChannelRecorder(channelId: string, captureType: 'video' | 'audio') {
    const key = _recKey(channelId, captureType);
    const best = _bestCaptureForChannel(channelId, captureType);
    const slot = channelRecorders.get(key);
    const currentId = slot?.captureId ?? null;
    const newId = best?.id ?? null;

    if (currentId === newId) return;

    if (slot?.recorder && slot.recorder.state === 'recording') {
      slot.captureId = newId; // claim new target before stop; re-entrant calls hit currentId === newId guard
      slot.recorder.stop();
    } else if (best) {
      await _startRecorderForChannel(channelId, captureType, best);
    } else {
      channelRecorders.delete(key);
      dbg('info', 'idb', `recording stopped for channel:${channelId} type:${captureType}`);
    }
  }

  async function _startRecorderForChannel(channelId: string, captureType: 'video' | 'audio', cap: CaptureMethod) {
    const ch = get(channels).find(c => c.id === channelId);
    if (!ch || cap.type === 'photo') return;

    const mimeType = _selectMimeType(cap);
    const videoBps = captureType === 'video' ? ((cap as { videoBitsPerSec?: number }).videoBitsPerSec ?? 0) || 500_000 : undefined;
    const audioBps = 'audioBitsPerSec' in cap && cap.audioBitsPerSec > 0 ? cap.audioBitsPerSec : 64_000;

    let recordStream: MediaStream;
    if (captureType === 'video') {
      const videoStream = ch.videoSourceId ? openStreams.get(ch.videoSourceId) : null;
      if (!videoStream) return;
      const tracks = videoStream.getVideoTracks();
      if (!tracks.length) return;
      recordStream = new MediaStream(tracks);
    } else {
      const audioStream = ch.audioSourceId ? openStreams.get(ch.audioSourceId) : null;
      if (!audioStream) return;
      const tracks = audioStream.getAudioTracks();
      if (!tracks.length) return;
      recordStream = new MediaStream(tracks);
    }

    const key = _recKey(channelId, captureType);
    const segStart = Math.floor(Date.now() / 1000);
    const slot: ChannelRecorderSlot = { recorder: null, captureId: cap.id, segmentStart: segStart, chunks: [] };
    channelRecorders.set(key, slot);

    function recordSegment() {
      const currentSlot = channelRecorders.get(key);
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
            await saveSegment(blob, mimeType, segBegin, segEnd, $identity.pubkey, channelId);
            dbg('info', 'idb', `segment saved ch:${channelId}/${captureType} [${segBegin}–${segEnd}] ${blob.size}B`);
          } catch (err) {
            dbg('warn', 'idb', `segment save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        const newBest = _bestCaptureForChannel(channelId, captureType);
        if (newBest && get(monitorState) === 'active') {
          if (newBest.id !== cap.id) {
            _startRecorderForChannel(channelId, captureType, newBest);
          } else {
            recordSegment();
          }
        } else {
          channelRecorders.delete(key);
        }
      };
      rec.onerror = (e) => dbg('warn', 'idb', `recorder error: ${(e as ErrorEvent).message ?? e}`);
      currentSlot.recorder = rec;
      currentSlot.segmentStart = Math.floor(Date.now() / 1000);
      rec.start();
      dbg('info', 'idb', `recording started ch:${channelId}/${captureType} cap:${cap.name} ${mimeType}`);
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
    const userMime = 'mimeType' in cap ? cap.mimeType : '';
    if (userMime && MediaRecorder.isTypeSupported(userMime)) return userMime;
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    return 'audio/webm';
  }

  // ── Detection handler (ClipActions + SnapshotActions) ────────────────────

  async function handleDetectionFired(
    sensorId: string,
    evt: { type: string; data: Record<string, unknown>; timestamp: number }
  ) {
    if (!$identity) return;

    // ClipActions: find enabled links targeting this sensor whose action is active
    const clipActions = $links
      .filter(l => l.enabled && l.sensorIds.includes(sensorId))
      .flatMap(l => l.actionIds.map(id => $actions.find(a => a.id === id)))
      .filter((a): a is ClipAction => a?.type === 'clip' && actionStates[a.id]?.status === 'active');

    for (const action of clipActions) {
      if (isStoring(get(monitorState))) {
        await _handleClipSession(action, evt);
      }
    }

    // SnapshotActions with finite count: fire burst on each detection while active
    const snapActions = $links
      .filter(l => l.enabled && l.sensorIds.includes(sensorId))
      .flatMap(l => l.actionIds.map(id => $actions.find(a => a.id === id)))
      .filter((a): a is SnapshotAction =>
        a?.type === 'snapshot' && a.snapshotCount > 0 && actionStates[a.id]?.status === 'active'
      );

    for (const action of snapActions) {
      if (!action.captureId) continue;
      const cap = $captures.find(c => c.id === action.captureId);
      if (cap?.type !== 'photo') continue;
      const stream = openStreams.get(cap.sourceId);
      if (!stream) continue;
      capturePhotosOnTrigger(stream, {
        snapshotCount: action.snapshotCount,
        intervalSec: action.intervalSec,
        imageWidth: cap.imageWidth,
        imageHeight: cap.imageHeight,
        imageQuality: cap.imageQuality,
        imageFormat: cap.imageFormat,
      }, $identity.pubkey, evt.timestamp, action.channelId)
        .then(async ids => {
          if (!ids.length) return;
          dbg('info', 'detector', `${ids.length} snapshot(s) stored for action ${action.name || action.id}`);
          if (action.pinLifetimeSec != null) {
            const now = Math.floor(Date.now() / 1000);
            const until = action.pinLifetimeSec === 0 ? 0 : now + action.pinLifetimeSec;
            const spanEnd = evt.timestamp + (action.snapshotCount - 1) * Math.max(action.intervalSec, 1) + 2;
            await pinRange(evt.timestamp, spanEnd, until, 'image/', action.channelId);
          }
        })
        .catch(err => dbg('warn', 'detector', `snapshot error: ${err instanceof Error ? err.message : err}`));
    }
  }

  async function _handleClipSession(
    action: ClipAction,
    evt: { type: string; timestamp: number; data: Record<string, unknown> },
  ) {
    if (!$identity) return;
    const durationMs = typeof evt.data.durationMs === 'number' ? evt.data.durationMs : 0;
    const eventEnd = evt.timestamp + Math.ceil(durationMs / 1000);
    const from = evt.timestamp - action.preRollSec;
    const to = eventEnd + action.postRollSec;
    let session = footageSessions.get(action.id);

    if (session && from > session.endTime) {
      if (session.timer) clearTimeout(session.timer);
      await _closeFootageSession(session, action.id, action);
      session = undefined;
      footageSessions.delete(action.id);
    }

    if (!session) {
      const ref = await createFootageRef({
        originMonitor: $identity.pubkey, triggerType: evt.type,
        channelId: action.channelId,
        startTime: from, endTime: to, triggerTime: evt.timestamp,
      });
      session = { refId: ref.refId, startTime: from, endTime: to, mimeType: 'audio/webm', triggerType: evt.type, channelId: action.channelId, timer: null };
      footageSessions.set(action.id, session);
      syncAlerts();
      dbg('info', 'idb', `clip session created: ${ref.refId.slice(0, 8)}…`);
    } else if (action.onRetrigger === 'restart') {
      // Close current session immediately and open a new one from this event
      if (session.timer) clearTimeout(session.timer);
      await _closeFootageSession(session, action.id, action);
      footageSessions.delete(action.id);
      const ref = await createFootageRef({
        originMonitor: $identity.pubkey, triggerType: evt.type,
        channelId: action.channelId,
        startTime: from, endTime: to, triggerTime: evt.timestamp,
      });
      session = { refId: ref.refId, startTime: from, endTime: to, mimeType: 'audio/webm', triggerType: evt.type, channelId: action.channelId, timer: null };
      footageSessions.set(action.id, session);
      syncAlerts();
      dbg('info', 'idb', `clip session restarted: ${ref.refId.slice(0, 8)}…`);
    } else if (action.onRetrigger === 'extend') {
      const newEnd = Math.max(session.endTime, to);
      if (newEnd > session.endTime) {
        await updateFootageRef(session.refId, { endTime: newEnd });
        session.endTime = newEnd;
        syncAlerts();
      }
    }
    // 'ignore': leave session as-is

    if (session.timer) clearTimeout(session.timer);
    const msUntilClose = Math.max(2000, (session.endTime * 1000 - Date.now()) + 2000);
    const capturedRefId = session.refId;
    const capturedActionId = action.id;
    session.timer = setTimeout(async () => {
      const s = footageSessions.get(capturedActionId);
      if (!s || s.refId !== capturedRefId) return;
      footageSessions.delete(capturedActionId);
      syncAlerts();
      await _closeFootageSession(s, capturedActionId, action);
    }, msUntilClose);
  }

  async function _closeFootageSession(
    s: { refId: string; startTime: number; endTime: number; mimeType: string; triggerType: string; channelId: string },
    actionId: string,
    action?: Action,
  ) {
    const cfg = get(settings);
    const now = Math.floor(Date.now() / 1000);
    if (action?.type === 'clip' && action.pinLifetimeSec != null) {
      const until = action.pinLifetimeSec === 0 ? 0 : now + action.pinLifetimeSec;
      const monPubkey = get(identity)?.pubkey;
      // Pin audio/video segments in the time window
      if (action.captureTypes.some(t => t === 'audio' || t === 'video')) {
        await pinRange(s.startTime, s.endTime, until, undefined, s.channelId);
      }
      // Pin photos taken during the window by this monitor
      if (action.captureTypes.includes('photo') && monPubkey) {
        const photos = await getPhotosInRange(s.startTime, s.endTime, monPubkey);
        await Promise.all(photos.map(p => pinPhoto(p.photoId, true)));
      }
    }
    dbg('info', 'idb', `clip session closed: ${s.refId.slice(0, 8)}… [${s.startTime}–${s.endTime}]`);
    const id = get(identity);
    if (!id || !isPublishing(get(monitorState)) || cfg.pauseNostr) return;
    const relays = getRelays();
    const preRoll = action?.type === 'clip' ? action.preRollSec : 30;
    for (const device of get(pairedDevices)) {
      const fev = buildFootageRefEvent(
        id.privkey, id.pubkey, device.pubkey,
        s.refId, s.triggerType, s.startTime, s.endTime,
        s.startTime + preRoll,
        s.channelId,
      );
      try { await publish(fev); } catch { await enqueue(fev, relays); }
    }
  }

  // ── Stop monitor ──────────────────────────────────────────────────────────

  async function stopMonitor() {
    transitionMonitor('stopping');
    if (cleanupTimer !== null) { clearInterval(cleanupTimer); cleanupTimer = null; }
    for (const [actionId, s] of footageSessions) {
      if (s.timer) clearTimeout(s.timer);
      const action = get(actions).find(a => a.id === actionId);
      await _closeFootageSession(s, actionId, action);
    }
    footageSessions.clear();
    for (const timer of actionDeactivationTimers.values()) clearTimeout(timer);
    actionDeactivationTimers.clear();
    for (const iv of snapshotIntervals.values()) clearInterval(iv);
    snapshotIntervals.clear();
    if (meterRaf !== null) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    meterCtx?.close();
    meterCtx = null;
    meterAnalysers.clear();
    sourceDb = new Map();
    openSourceIds = new Set();
    for (const det of activeDetectors.values()) det.stop();
    activeDetectors.clear();
    for (const sub of nostrTriggerSubs.values()) sub.close();
    nostrTriggerSubs.clear();
    for (const slot of channelRecorders.values()) {
      if (slot.recorder?.state === 'recording') slot.recorder.stop();
    }
    channelRecorders.clear();
    for (const stream of openStreams.values()) stream.getTracks().forEach(t => t.stop());
    openStreams.clear();
    pendingStreams.clear();
    setMonitorRollingBuffer(null);
    setMonitorStream(null);
    stopAllMonitorSessions();
    sensorStates = {};
    actionStates = {};
    notifyCooldowns.clear();
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

  function sensorBadgeText(st: SensorState | undefined): string {
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

  function actionBadgeText(st: ActionState | undefined): string {
    if (!st || st.status === 'idle') return 'IDLE';
    if (st.status === 'active') {
      const elapsed = ((Date.now() - st.startedAt) / 1000).toFixed(1);
      return `ACTIVE ${elapsed}s`;
    }
    if (st.status === 'cooldown') {
      const rem = Math.max(0, Math.ceil((st.endsAt - Date.now()) / 1000));
      return `COOLDOWN ${rem}s`;
    }
    return '—';
  }

  const statusBadge = $derived(
    $monitorState === 'starting'  ? { label: 'STARTING',         color: 'var(--color-warning)' }
    : $monitorState === 'stopping'? { label: 'STOPPING',         color: 'var(--color-warning)' }
    : isActive                    ? { label: 'RUNNING',          color: 'var(--color-success)' }
    : sessions.some(s => s.iceState === 'connected' || s.iceState === 'completed')
                                  ? { label: 'CONNECTED',        color: 'var(--color-accent)'  }
    : signalRouterActive && autoAccept
                                  ? { label: 'LISTENING · AUTO', color: 'var(--color-warning)' }
    : signalRouterActive          ? { label: 'LISTENING',        color: 'var(--color-warning)' }
                                  : { label: 'IDLE',             color: 'var(--color-border)'  }
  );

  function _wireDetection() {
    for (const [sensorId, det] of activeDetectors.entries()) {
      det.onDetection = (evt: DetectionEvent<Record<string, unknown>>) => handleDetectionFired(sensorId, evt);
    }
  }
  $effect(() => { if (isActive) _wireDetection(); });

  // Alias to avoid shadowing by {#snippet actions()} in the template
  const actionsData = $derived($actions);
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
    <pre class="raw">{JSON.stringify(monitorSnapshot ?? { settings: $settings, sources: $sources, sensors: $sensors, captures: $captures, actions: actionsData, links: $links }, null, 2)}</pre>
  {/if}

  <!-- Video preview -->
  <video bind:this={videoEl} autoplay muted playsinline controls class="camera-preview"
    class:hidden={!isActive || !$sources.some(s => openSourceIds.has(s.id) && (s.type === 'camera' || s.type === 'screen'))}></video>

  <!-- Pipeline status — Sources / Sensors / Actions / Links (while running) -->
  {#if isActive}
    <div class="pipeline-status">

      <div class="ps-header">Sources</div>
      {#each $sources.filter(s => openSourceIds.has(s.id)) as src (src.id)}
        <div class="ps-row">
          <span class="ps-badge {src.type === 'microphone' ? 'mic' : src.type === 'camera' ? 'cam' : 'screen'}">
            {src.type === 'microphone' ? 'MIC' : src.type === 'camera' ? 'CAM' : 'SCRN'}
          </span>
          <span class="ps-name">{src.name}</span>
          {#if sourceDb.has(src.id)}
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
          <span class="ps-badge {sensor.type === 'nostr-trigger' ? 'nostr' : sensor.type === 'schedule' || sensor.type === 'timewindow' || sensor.type === 'daterange' ? 'sched' : 'audio'}">
            {sensor.type === 'schedule' ? 'TIMER' : sensor.type === 'timewindow' ? 'TIME' : sensor.type === 'daterange' ? 'DATE' : sensor.type === 'nostr-trigger' ? 'NOSTR' : 'AUDIO'}
          </span>
          <span class="ps-name">{sensor.name || autoNameSensor(sensor, $sources)}</span>
          <span class="ps-state {st?.status ?? 'inactive'}">{sensorBadgeText(st)}</span>
        </div>
      {/each}
      {#if $sensors.filter(s => s.enabled).length === 0}
        <div class="ps-empty">No enabled sensors</div>
      {/if}

      <div class="ps-header">Actions</div>
      {#each actionsData.filter(a => $links.some(l => l.enabled && l.actionIds.includes(a.id))) as action (action.id)}
        {@const st = actionStates[action.id]}
        {@const session = action.type === 'clip' ? activeAlerts.find(a => a.actionId === action.id) : null}
        <div class="ps-row">
          <span class="ps-badge {action.type === 'record' ? 'link-actv' : action.type === 'clip' ? 'link-pin' : action.type === 'snapshot' ? 'link-photo' : 'link-act'}">
            {action.type === 'record' ? 'REC' : action.type === 'clip' ? 'CLIP' : action.type === 'snapshot' ? 'SNAP' : 'NTFY'}
          </span>
          <span class="ps-name">{action.name || autoNameAction(action, $captures, $channels, $sources)}</span>
          {#if action.type !== 'notify'}
            <span class="ps-state {st?.status ?? 'idle'}">{actionBadgeText(st)}</span>
          {/if}
          {#if session}
            <span class="ps-session">[clip] {fmtDur(Math.floor(Date.now() / 1000) - session.startTime)}</span>
          {/if}
        </div>
      {/each}
      {#if actionsData.filter(a => $links.some(l => l.enabled && l.actionIds.includes(a.id))).length === 0}
        <div class="ps-empty">No enabled actions</div>
      {/if}

      <div class="ps-header">Links</div>
      {#each $links.filter(l => l.enabled) as link (link.id)}
        <div class="ps-row">
          <span class="ps-badge link-lnk">LNK</span>
          <span class="ps-name">{link.name || autoNameLink(link, $sensors, actionsData, $sources)}</span>
          <span class="ps-link-actions">{link.actionIds.length} action{link.actionIds.length !== 1 ? 's' : ''}</span>
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
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); }

  .monitor-btn { width: 100%; padding: 8px 0; border-radius: 6px; border: none; font-size: 13px; font-weight: 700; font-family: inherit; cursor: pointer; letter-spacing: 0.03em; transition: opacity 0.15s; }
  .monitor-btn:disabled { opacity: 0.5; cursor: default; }
  .monitor-btn.start { background: var(--color-success); color: white; }
  .monitor-btn.stop  { background: transparent; color: var(--color-danger); border: 1px solid var(--color-danger); }
  .monitor-btn.start:hover:not(:disabled) { opacity: 0.88; }
  .monitor-btn.stop:hover:not(:disabled)  { background: rgba(239,68,68,0.08); }

  .err-msg { font-size: 11px; color: var(--color-danger); padding: 4px 8px; background: rgba(239,68,68,0.1); border-radius: 4px; }
  .camera-preview { width: 100%; border-radius: 8px; background: #000; max-height: 220px; }
  .camera-preview.hidden { display: none; }

  .pipeline-status { display: flex; flex-direction: column; gap: 3px; }
  .ps-header { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 6px; }
  .ps-row { display: flex; align-items: center; gap: 6px; min-height: 22px; }
  .ps-empty { font-size: 10px; color: var(--color-muted); font-style: italic; padding-left: 2px; }
  .ps-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; flex-shrink: 0; color: white; }
  .ps-badge.mic      { background: #2563eb; }
  .ps-badge.cam      { background: #7c3aed; }
  .ps-badge.screen   { background: #0e7490; }
  .ps-badge.audio    { background: #2563eb; }
  .ps-badge.sched    { background: #0891b2; }
  .ps-badge.nostr    { background: #7c3aed; }
  .ps-badge.link-actv  { background: #d97706; }
  .ps-badge.link-pin   { background: #0f766e; }
  .ps-badge.link-photo { background: #059669; }
  .ps-badge.link-act   { background: #6d28d9; }
  .ps-badge.link-lnk   { background: #475569; }
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
  .ps-state.cooldown { background: #7c3aed; color: white; }
  .ps-session { font-size: 10px; color: var(--color-danger); font-family: ui-monospace, monospace; font-weight: 600; }

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
