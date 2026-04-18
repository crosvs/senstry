<script lang="ts">
  /**
   * DEV PANEL — single-page debug interface for Senstry.
   *
   * Every section shows live values from stores or manually-read IDB snapshots.
   * Status badges:  LIVE (green) = reactive store, updates automatically
   *                 CACHED (blue) = read from IDB on demand, may be stale
   *                 STALE (yellow) = cached but not refreshed in >30 s
   *
   * "Dev mode" toggle (bottom of page): shows raw JSON under each value.
   * Log (bottom): all inbound/outbound Nostr and WebRTC signaling messages.
   *
   * This page is intentionally dense. Strip sections you don't need once
   * the app is working.
   */

  import { onMount, onDestroy, tick } from "svelte";
  import {
    identity,
    pairedDevices,
    addPairedDevice,
    removePairedDevice,
  } from "$lib/store/identity";
  import { settings } from "$lib/store/settings";
  import { triggers, loadTriggers } from "$lib/store/triggers";
  import { streamState, remoteStream } from "$lib/store/stream";
  import {
    events,
    loadEventsInRange,
    upsertEvent,
    type StoredTriggerEvent,
  } from "$lib/store/events";
  import { debugLog, clearLog } from "$lib/store/debug";
  import type { LogDir, LogSource } from "$lib/store/debug";
  import { openDB } from "$lib/db/idb";
  import {
    DEFAULT_QUOTA_BYTES,
    saveSegment,
    pinRange,
    getCoverageMap,
    PRE_ROLL_S,
    POST_ROLL_S,
  } from "$lib/db/segments";
  import {
    getRelays,
    getActiveSubs,
    publish,
    subscribe,
    setRelays,
  } from "$lib/nostr/client";
  import { toNpub, toNsec } from "$lib/nostr/keys";
  import { finalizeEvent } from "nostr-tools/pure";
  import {
    getViewerSessionInfo,
    getViewerRTCStats,
    requestCoverageMap,
    requestSegment,
    ensureConnection,
    requestLiveView,
    stopViewer,
  } from "$lib/webrtc/viewer-peer";
  import {
    getMonitorSessionInfo,
    getMonitorRTCStats,
    startMonitorSignaling,
    stopMonitorSignaling,
    startPairListener,
    stopPairListener,
  } from "$lib/webrtc/monitor-peer";
  import { AudioDetector } from "$lib/detectors/audio";
  import {
    buildTriggerEvent,
    buildPairAck,
    KIND_TRIGGER,
    KIND_ARM_STATE,
  } from "$lib/nostr/events";
  import {
    generateQRDataUrl,
    encodePairingUri,
    decodePairingUri,
  } from "$lib/utils/qr";
  import { getSegmentAt } from "$lib/db/segments";
  import TimelineView from "$lib/components/timeline/TimelineView.svelte";
  import CalendarRoot from "$lib/components/calendar/CalendarRoot.svelte";

  // ── Dev mode toggle ────────────────────────────────────────────────────────
  let devMode = $state(false);

  // ── Tick (drives elapsed-time labels and bandwidth counters) ───────────────
  let now = $state(Date.now());
  let tickInterval: ReturnType<typeof setInterval>;

  // ── IDB snapshot values (CACHED) ───────────────────────────────────────────
  interface IDBSnapshot {
    segmentCount: number;
    segmentsMb: number;
    pinnedCount: number;
    eventCount: number;
    quotaMb: number;
    readAt: number;
  }
  let idb = $state<IDBSnapshot | null>(null);

  async function readIDB() {
    const db = await openDB();
    const segs = (await db.getAll("segments")) as {
      pinned: boolean;
      sizeBytes: number;
    }[];
    const evts = await db.getAll("events");
    const quota =
      ((await db.get("settings", "segments.quotaBytes")) as
        | number
        | undefined) ?? DEFAULT_QUOTA_BYTES;
    idb = {
      segmentCount: segs.length,
      segmentsMb:
        Math.round(segs.reduce((s, c) => s + c.sizeBytes, 0) / 1024 / 10.24) /
        100,
      pinnedCount: segs.filter((s) => s.pinned).length,
      eventCount: evts.length,
      quotaMb: Math.round(quota / 1024 / 1024),
      readAt: Date.now(),
    };
  }

  async function clearSegments() {
    if (!confirm("Delete ALL stored audio segments? This cannot be undone."))
      return;
    const db = await openDB();
    await db.clear("segments");
    readIDB();
  }

  async function clearEvents() {
    if (!confirm("Delete ALL stored events from IDB? This cannot be undone."))
      return;
    const db = await openDB();
    await db.clear("events");
    events.set([]);
    readIDB();
  }

  // ── Coverage map (CACHED — requires live WebRTC connection) ────────────────
  let coverage = $state<[number, number][] | null>(null);
  let coverageError = $state("");
  let coverageReadAt = $state(0);

  async function readCoverage() {
    if (!$identity || !$pairedDevices[0]) {
      coverageError = "No identity or paired device";
      return;
    }
    coverageError = "";
    try {
      coverage = await requestCoverageMap(
        $identity.privkey,
        $identity.pubkey,
        $pairedDevices[0].pubkey,
      );
      coverageReadAt = Date.now();
    } catch (e) {
      coverageError = e instanceof Error ? e.message : String(e);
    }
  }

  // ── WebRTC session snapshot ─────────────────────────────────────────────────
  let viewerInfo = $state(getViewerSessionInfo());
  let monitorInfo = $state(getMonitorSessionInfo());
  let rtcStats = $state<{ type: string; id: string; [k: string]: unknown }[]>(
    [],
  );
  let rtcStatsExpanded = $state(false);

  async function readRTCStats() {
    const report = (await getViewerRTCStats()) ?? (await getMonitorRTCStats());
    if (!report) {
      rtcStats = [];
      return;
    }
    rtcStats = [];
    report.forEach((s) =>
      rtcStats.push(s as { type: string; id: string; [k: string]: unknown }),
    );
  }

  function refreshRTCInfo() {
    viewerInfo = getViewerSessionInfo();
    monitorInfo = getMonitorSessionInfo();
  }

  // ── Active Nostr subscriptions (polled) ────────────────────────────────────
  let activeSubs = $state(getActiveSubs());

  // ── Custom Nostr publisher ─────────────────────────────────────────────────
  let publishKind = $state("5010");
  let publishContent = $state('{"test":true}');
  let publishResult = $state("");

  async function sendTestEvent() {
    if (!$identity) {
      publishResult = "No identity";
      return;
    }
    try {
      const ev = finalizeEvent(
        {
          kind: parseInt(publishKind, 10),
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: publishContent,
        },
        $identity.privkey,
      );
      await publish(ev);
      publishResult = `Published id:${ev.id.slice(0, 12)}`;
    } catch (e) {
      publishResult = String(e);
    }
  }

  // ── Custom Nostr subscriber ────────────────────────────────────────────────
  let subKindInput = $state("5010");
  let subPubkeyInput = $state("");
  let manualSubs: { close: () => void }[] = [];

  function addManualSub() {
    const kinds = subKindInput
      .split(",")
      .map((k) => parseInt(k.trim(), 10))
      .filter(Number.isFinite);
    const filter: { kinds: number[]; "#p"?: string[] } = { kinds };
    if (subPubkeyInput.trim()) filter["#p"] = [subPubkeyInput.trim()];
    const sub = subscribe(filter as never, () => {});
    manualSubs.push(sub);
    activeSubs = getActiveSubs();
  }

  // ── Key reveal ─────────────────────────────────────────────────────────────
  let showPrivkey = $state(false);

  function serializeLogs(): string {
    return $debugLog
      .map(
        (e) =>
          `${fmtTime(e.ts)} ${e.dir.toUpperCase().padEnd(5)} [${e.source}] ${e.label}${e.bytes ? ` (${fmtBytes(e.bytes)})` : ""}${e.raw ? "\n" + e.raw : ""}`,
      )
      .join("\n---\n");
  }

  function copyLogs(): void {
    navigator.clipboard.writeText(serializeLogs());
  }

  function exportLogs(): void {
    const blob = new Blob([serializeLogs()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `senstry-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Log filters ────────────────────────────────────────────────────────────
  let logFilterSource = $state<LogSource | "all">("all");
  let logFilterDir = $state<LogDir | "all">("all");
  let logExpandedId = $state<number | null>(null);

  let filteredLog = $derived(
    $debugLog.filter(
      (e) =>
        (logFilterSource === "all" || e.source === logFilterSource) &&
        (logFilterDir === "all" || e.dir === logFilterDir),
    ),
  );

  // ── Bandwidth (events/min from last 60 s of log) ───────────────────────────
  let bwIn = $derived(() => {
    const cutoff = now - 60_000;
    return $debugLog.filter((e) => e.ts >= cutoff && e.dir === "in").length;
  });
  let bwOut = $derived(() => {
    const cutoff = now - 60_000;
    return $debugLog.filter((e) => e.ts >= cutoff && e.dir === "out").length;
  });
  let bytesIn = $derived(() => {
    const cutoff = now - 60_000;
    return $debugLog
      .filter((e) => e.ts >= cutoff && e.dir === "in")
      .reduce((s, e) => s + (e.bytes ?? 0), 0);
  });
  let bytesOut = $derived(() => {
    const cutoff = now - 60_000;
    return $debugLog
      .filter((e) => e.ts >= cutoff && e.dir === "out")
      .reduce((s, e) => s + (e.bytes ?? 0), 0);
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function elapsed(ts: number): string {
    const s = Math.round((now - ts) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  function badge(ts: number | undefined, isLive = false): string {
    if (isLive) return "LIVE";
    if (!ts) return "CACHED";
    return now - ts > 30_000 ? "STALE" : "CACHED";
  }

  function badgeColor(b: string): string {
    if (b === "LIVE") return "#16a34a";
    if (b === "STALE") return "#ca8a04";
    return "#3b82f6";
  }

  function dirColor(dir: LogDir): string {
    const m: Record<LogDir, string> = {
      in: "#22c55e",
      out: "#60a5fa",
      info: "#9ca3af",
      warn: "#fbbf24",
      error: "#ef4444",
    };
    return m[dir];
  }

  function srcColor(src: LogSource): string {
    const m: Record<LogSource, string> = {
      nostr: "#a78bfa",
      rtc: "#fb923c",
      idb: "#34d399",
      detector: "#f472b6",
      app: "#9ca3af",
    };
    return m[src];
  }

  function fmtBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function fmtUnix(t: number): string {
    return new Date(t * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  // ── Pairing section ────────────────────────────────────────────────────────
  let pairQrSrc = $state("");
  let pairUri = $state("");
  let pairManualInput = $state("");
  let pairError = $state("");
  let pairSuccess = $state("");

  async function generatePairQR(): Promise<void> {
    if (!$identity) return;
    const payload = {
      v: 1,
      pk: $identity.pubkey,
      relay: $settings.relayUrl,
      label: $settings.monitorLabel,
    };
    pairUri = encodePairingUri(payload);
    pairQrSrc = await generateQRDataUrl(pairUri);
    // Start listening for pair-acks so the monitor auto-adds the viewer when they scan.
    // (startMonitorSignaling also calls this, but the QR might be shown before monitor mode starts.)
    startPairListener($identity.privkey, $identity.pubkey);
  }

  async function handleManualPair(): Promise<void> {
    pairError = "";
    pairSuccess = "";
    if (!$identity) return;
    try {
      const payload = decodePairingUri(pairManualInput.trim());
      setRelays([payload.relay]);
      const ack = buildPairAck(
        $identity.privkey,
        $identity.pubkey,
        payload.pk,
        "Viewer",
      );
      await publish(ack);
      await addPairedDevice({
        pubkey: payload.pk,
        label: payload.label,
        addedAt: Date.now(),
      });
      pairSuccess = `Paired: ${payload.label} (${payload.pk.slice(0, 16)}…)`;
      pairManualInput = "";
    } catch (e) {
      pairError = e instanceof Error ? e.message : "Invalid pairing URI";
    }
  }

  async function unpairDevice(pubkey: string): Promise<void> {
    if (!confirm("Remove this paired device?")) return;
    await removePairedDevice(pubkey);
  }

  // ── Viewer manual API ──────────────────────────────────────────────────────
  let viewerApiTime = $state("");
  let viewerApiCoverageResult = $state("");
  let viewerApiSegmentResult = $state("");
  let viewerApiSegmentBlobUrl = $state("");
  let viewerApiSegmentMimeType = $state("");
  let viewerApiLoading = $state(false);

  async function apiRequestCoverage(): Promise<void> {
    if (!$identity || !$pairedDevices[0]) {
      viewerApiCoverageResult = "No identity or paired device";
      return;
    }
    viewerApiLoading = true;
    try {
      const ranges = await requestCoverageMap(
        $identity.privkey,
        $identity.pubkey,
        $pairedDevices[0].pubkey,
      );
      viewerApiCoverageResult =
        ranges.length === 0
          ? "empty — no segments on monitor"
          : ranges
              .map(([s, e]) => `${fmtUnix(s)}–${fmtUnix(e)} (${e - s}s)`)
              .join(", ");
    } catch (e) {
      viewerApiCoverageResult = `error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      viewerApiLoading = false;
    }
  }

  async function apiRequestSegment(): Promise<void> {
    if (!$identity || !$pairedDevices[0]) {
      viewerApiSegmentResult = "No identity or paired device";
      return;
    }
    const t = parseInt(viewerApiTime, 10);
    if (!t) {
      viewerApiSegmentResult = "Enter a unix timestamp";
      return;
    }
    viewerApiLoading = true;
    viewerApiSegmentResult = "";
    if (viewerApiSegmentBlobUrl) {
      URL.revokeObjectURL(viewerApiSegmentBlobUrl);
      viewerApiSegmentBlobUrl = "";
    }
    viewerApiSegmentMimeType = "";
    try {
      const result = await requestSegment(
        t,
        $identity.privkey,
        $identity.pubkey,
        $pairedDevices[0].pubkey,
      );
      viewerApiSegmentMimeType = result.mimeType;
      viewerApiSegmentBlobUrl = URL.createObjectURL(result.blob);
      viewerApiSegmentResult = `startTime:${result.startTime} endTime:${result.endTime} mime:${result.mimeType} size:${fmtBytes(result.blob.size)}`;
    } catch (e) {
      viewerApiSegmentResult = `error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      viewerApiLoading = false;
    }
  }

  async function apiLocalSegment(): Promise<void> {
    const t = parseInt(viewerApiTime, 10);
    if (!t) {
      viewerApiSegmentResult = "Enter a unix timestamp";
      return;
    }
    viewerApiLoading = true;
    viewerApiSegmentResult = "";
    if (viewerApiSegmentBlobUrl) {
      URL.revokeObjectURL(viewerApiSegmentBlobUrl);
      viewerApiSegmentBlobUrl = "";
    }
    viewerApiSegmentMimeType = "";
    try {
      const seg = await getSegmentAt(t);
      if (!seg) {
        viewerApiSegmentResult = "not-stored";
        return;
      }
      viewerApiSegmentMimeType = seg.mimeType;
      viewerApiSegmentBlobUrl = URL.createObjectURL(seg.blob);
      viewerApiSegmentResult = `startTime:${seg.startTime} endTime:${seg.endTime} mime:${seg.mimeType} size:${fmtBytes(seg.sizeBytes)} pinned:${seg.pinned}`;
    } catch (e) {
      viewerApiSegmentResult = `error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      viewerApiLoading = false;
    }
  }

  // ── Monitor section ────────────────────────────────────────────────────────
  let monitorRunning = $state(false);
  let monitorArmed = $state(false);
  let monitorError = $state("");
  let monitorPeakDb = $state(-Infinity);
  let monitorMimeType = $state("");
  let monitorSegmentsWritten = $state(0);
  let monitorVideoEl: HTMLVideoElement | undefined = $state();
  let monitorStream: MediaStream | null = null;
  let monitorRecorder = $state<MediaRecorder | null>(null);
  let monitorDetectors: AudioDetector[] = [];
  let monitorMeterCtx: AudioContext | null = null;
  let monitorMeterAnalyser: AnalyserNode | null = null;
  let monitorMeterRafId: number | null = null;
  let monitorMeterBuf: Float32Array<ArrayBuffer> | null = null;
  let monitorSegmentStart = 0;
  interface MonitorSessionEvent {
    ts: number;
    triggerName: string;
    peakDb: number;
    durationMs: number;
    eventId: string;
  }
  let monitorSessionEvents = $state<MonitorSessionEvent[]>([]);
  let monitorLastNostrEvent = $state<object | null>(null);
  let monitorLocalCoverage = $state<[number, number][]>([]);

  async function startMonitorDev(): Promise<void> {
    if (!$identity) {
      monitorError = "No identity — set up keys first";
      return;
    }
    monitorError = "";
    await loadTriggers();
    try {
      monitorStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      let mimeType: string;
      let recordStream: MediaStream;
      if ($settings.recordVideo) {
        mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
          ? "video/webm;codecs=vp9,opus"
          : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
            ? "video/webm;codecs=vp8,opus"
            : "video/webm";
        recordStream = monitorStream;
      } else {
        mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
        recordStream = new MediaStream(monitorStream.getAudioTracks());
      }
      monitorMimeType = mimeType;

      const rec = new MediaRecorder(recordStream, { mimeType });
      monitorRecorder = rec;
      monitorSegmentStart = Math.floor(Date.now() / 1000);
      let initChunk: Blob | null = null;
      rec.ondataavailable = async (e) => {
        if (e.data.size === 0) return;
        const end = Math.floor(Date.now() / 1000);
        const blob = initChunk
          ? new Blob([initChunk, e.data], { type: mimeType })
          : new Blob([e.data], { type: mimeType });
        if (!initChunk) initChunk = e.data;
        await saveSegment(blob, mimeType, monitorSegmentStart, end);
        monitorSegmentStart = end;
        monitorSegmentsWritten++;
        monitorLocalCoverage = await getCoverageMap();
        readIDB();
      };
      rec.start(10_000);

      for (const cfg of $triggers.filter((t) => t.enabled)) {
        const det = new AudioDetector(cfg);
        det.onDetection = async (evt) => {
          if (!monitorArmed || !$identity) return;
          await handleMonitorTrigger(evt, cfg.name);
        };
        det.start(monitorStream!);
        monitorDetectors.push(det);
      }

      monitorMeterCtx = new AudioContext();
      monitorMeterAnalyser = monitorMeterCtx.createAnalyser();
      monitorMeterAnalyser.fftSize = 1024;
      monitorMeterBuf = new Float32Array(
        monitorMeterAnalyser.fftSize,
      ) as unknown as Float32Array<ArrayBuffer>;
      monitorMeterCtx
        .createMediaStreamSource(monitorStream)
        .connect(monitorMeterAnalyser);
      const meterTick = () => {
        if (!monitorMeterAnalyser || !monitorMeterBuf) return;
        monitorMeterRafId = requestAnimationFrame(meterTick);
        monitorMeterAnalyser.getFloatTimeDomainData(monitorMeterBuf);
        const rms = Math.sqrt(
          monitorMeterBuf.reduce((s, v) => s + v * v, 0) /
            monitorMeterBuf.length,
        );
        monitorPeakDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      };
      monitorMeterRafId = requestAnimationFrame(meterTick);

      startMonitorSignaling($identity.privkey, $identity.pubkey, monitorStream);
      monitorRunning = true;
      await tick();
      if (monitorVideoEl) monitorVideoEl.srcObject = monitorStream;
    } catch (e) {
      monitorError =
        e instanceof Error ? e.message : "Camera/mic access failed";
    }
  }

  async function handleMonitorTrigger(
    evt: {
      type: string;
      data: { peakDb: number; durationMs: number };
      timestamp: number;
    },
    triggerName: string,
  ): Promise<void> {
    const vp = $pairedDevices[0]?.pubkey;
    if (!vp || !$identity) return;
    const eventEnd = evt.timestamp + Math.ceil(evt.data.durationMs / 1000);
    await pinRange(evt.timestamp - PRE_ROLL_S, eventEnd + POST_ROLL_S);
    const nostrEvent = buildTriggerEvent(
      $identity.privkey,
      $identity.pubkey,
      vp,
      evt.type,
      $settings.monitorLabel,
      { peakDb: evt.data.peakDb, durationMs: evt.data.durationMs, triggerName },
    );
    await publish(nostrEvent);
    monitorLastNostrEvent = nostrEvent;
    const stored: StoredTriggerEvent = {
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
    };
    const db = await openDB();
    await db.put("events", stored);
    events.update((list) =>
      [...list, stored].sort((a, b) => b.created_at - a.created_at),
    );
    monitorSessionEvents = [
      {
        ts: evt.timestamp,
        triggerName,
        peakDb: evt.data.peakDb,
        durationMs: evt.data.durationMs,
        eventId: nostrEvent.id,
      },
      ...monitorSessionEvents,
    ];
  }

  async function manualFireTrigger(): Promise<void> {
    const firstTrigger = $triggers.find((t) => t.enabled);
    if (!firstTrigger) {
      monitorError = "No enabled trigger found";
      return;
    }
    await handleMonitorTrigger(
      {
        type: "audio",
        data: { peakDb: firstTrigger.thresholdDb + 5, durationMs: 1000 },
        timestamp: Math.floor(Date.now() / 1000),
      },
      firstTrigger.name + " (manual test)",
    );
  }

  function stopMonitorDev(): void {
    if (monitorMeterRafId !== null) cancelAnimationFrame(monitorMeterRafId);
    monitorMeterCtx?.close();
    monitorMeterCtx = null;
    monitorDetectors.forEach((d) => d.stop());
    monitorDetectors = [];
    monitorRecorder?.stop();
    monitorRecorder = null;
    monitorStream?.getTracks().forEach((t) => t.stop());
    monitorStream = null;
    stopMonitorSignaling();
    monitorRunning = false;
    monitorArmed = false;
    monitorPeakDb = -Infinity;
    monitorSegmentsWritten = 0;
  }

  async function refreshMonitorCoverage(): Promise<void> {
    monitorLocalCoverage = await getCoverageMap();
  }

  // ── Viewer section ─────────────────────────────────────────────────────────
  let viewerRunning = $state(false);
  let viewerConnecting = $state(false);
  let viewerError = $state("");
  let viewerVideoEl: HTMLVideoElement | undefined = $state();
  let viewerNearLive = $state(true);

  $effect(() => {
    if (viewerVideoEl && $remoteStream) viewerVideoEl.srcObject = $remoteStream;
  });

  $effect(() => {
    if (viewerVideoEl) viewerVideoEl.muted = !viewerNearLive;
  });

  async function connectViewerDev(): Promise<void> {
    if (!$identity || !$pairedDevices[0]) {
      viewerError = "No identity or paired device";
      return;
    }
    viewerConnecting = true;
    viewerError = "";
    try {
      await ensureConnection(
        $identity.privkey,
        $identity.pubkey,
        $pairedDevices[0].pubkey,
      );
      viewerRunning = true;
    } catch (e) {
      viewerError = e instanceof Error ? e.message : "Connection failed";
    } finally {
      viewerConnecting = false;
    }
  }

  async function forceReconnectViewerDev(): Promise<void> {
    if (!$identity || !$pairedDevices[0]) return;
    viewerConnecting = true;
    viewerError = "";
    try {
      await requestLiveView(
        $identity.privkey,
        $identity.pubkey,
        $pairedDevices[0].pubkey,
      );
      viewerRunning = true;
    } catch (e) {
      viewerError = e instanceof Error ? e.message : "Reconnect failed";
    } finally {
      viewerConnecting = false;
    }
  }

  function disconnectViewerDev(): void {
    stopViewer();
    viewerRunning = false;
  }

  // ── Event Log section ──────────────────────────────────────────────────────
  let eventsLoaded = $state(false);
  let eventsLoadRange = $state<"7d" | "30d" | "custom">("7d");
  let eventsCustomFrom = $state("");
  let eventsCustomTo = $state("");
  let eventsNostrSub: { close: () => void } | null = null;

  // Viewer relay fetch
  let viewerEventsMonitorKey = $state("");
  let viewerEventsSub = $state<{ close: () => void } | null>(null);
  let viewerEventsReceived = $state(0);
  let viewerEventsFetching = $state(false);
  let viewerEventsError = $state("");

  $effect(() => {
    if (!viewerEventsMonitorKey && $pairedDevices[0])
      viewerEventsMonitorKey = $pairedDevices[0].pubkey;
  });

  function resolveRange(): { from: number; to: number } {
    const n = Math.floor(Date.now() / 1000);
    if (eventsLoadRange === "7d") return { from: n - 7 * 86400, to: n };
    if (eventsLoadRange === "30d") return { from: n - 30 * 86400, to: n };
    return {
      from: eventsCustomFrom
        ? Math.floor(new Date(eventsCustomFrom).getTime() / 1000)
        : n - 7 * 86400,
      to: eventsCustomTo
        ? Math.floor(new Date(eventsCustomTo).getTime() / 1000)
        : n,
    };
  }

  async function loadEventsDev(range: "7d" | "30d" | "custom"): Promise<void> {
    if (!$identity) return;
    eventsLoadRange = range;
    const { from, to } = resolveRange();
    const loaded = await loadEventsInRange(from, to);
    events.set(loaded.sort((a, b) => b.created_at - a.created_at));
    eventsLoaded = true;
    // Keep a live subscription for new local events (monitor side)
    eventsNostrSub?.close();
    eventsNostrSub = subscribe(
      {
        kinds: [KIND_TRIGGER, KIND_ARM_STATE],
        "#p": [$identity.pubkey],
      } as import("nostr-tools").Filter,
      (event) => {
        if ($identity) upsertEvent(event, $identity.privkey);
      },
    );
    activeSubs = getActiveSubs();
  }

  async function fetchViewerEvents(): Promise<void> {
    if (!$identity) {
      viewerEventsError = "No identity";
      return;
    }
    if (!viewerEventsMonitorKey.trim()) {
      viewerEventsError = "Enter monitor pubkey";
      return;
    }
    viewerEventsError = "";
    viewerEventsReceived = 0;
    viewerEventsFetching = true;
    viewerEventsSub?.close();
    const { from, to } = resolveRange();
    const filter: import("nostr-tools").Filter = {
      kinds: [KIND_TRIGGER, KIND_ARM_STATE],
      "#p": [$identity.pubkey],
      authors: [viewerEventsMonitorKey.trim()],
      since: from,
      until: to,
    };
    viewerEventsSub = subscribe(
      filter,
      async (event) => {
        if (!$identity) return;
        await upsertEvent(event, $identity.privkey);
        viewerEventsReceived++;
      },
      () => {
        viewerEventsFetching = false;
        activeSubs = getActiveSubs();
      },
    );
    activeSubs = getActiveSubs();
  }

  async function deleteEvent(id: string): Promise<void> {
    if (!confirm("Delete this event from IDB? This cannot be undone.")) return;
    const db = await openDB();
    await db.delete("events", id);
    events.update((list) => list.filter((e) => e.id !== id));
    readIDB();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  onMount(() => {
    readIDB();
    tickInterval = setInterval(() => {
      now = Date.now();
      activeSubs = getActiveSubs();
      refreshRTCInfo();
    }, 2000);
  });

  onDestroy(() => {
    clearInterval(tickInterval);
    manualSubs.forEach((s) => s.close());
    eventsNostrSub?.close();
    viewerEventsSub?.close();
    if (monitorRunning) stopMonitorDev();
    else stopPairListener();
    if (viewerRunning) disconnectViewerDev();
  });
</script>

<svelte:head><title>Dev Panel — Senstry</title></svelte:head>

<div class="dev">
  <!-- ═══════════════════════════════════════════════════════════════
	     HEADER — identity, relay status, bandwidth at a glance
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="header">
    <span style="color:#a78bfa;font-weight:700">NOSTIOR DEV</span>

    {#if $identity}
      <span style="color:#71717a" title="Your Nostr public key (npub format)"
        >{toNpub($identity.pubkey).slice(0, 20)}…</span
      >
    {:else}
      <span style="color:#ef4444">NO IDENTITY</span>
    {/if}

    <span style="color:#27272a">|</span>

    {#each getRelays() as relay}
      <span style="color:#6b7280" title="Active relay URL">{relay}</span>
    {/each}

    <span style="color:#27272a">|</span>

    <span
      title="WebRTC stream state"
      style="color:{$streamState === 'connected'
        ? '#22c55e'
        : $streamState === 'connecting'
          ? '#fbbf24'
          : '#ef4444'}"
    >
      ● {$streamState.toUpperCase()}
    </span>

    <span style="color:#27272a">|</span>

    <span title="Nostr events received in last 60 s" style="color:#22c55e"
      >↓{bwIn()} ev/min</span
    >
    <span title="Nostr events published in last 60 s" style="color:#60a5fa"
      >↑{bwOut()} ev/min</span
    >
    <span title="Estimated bytes received in last 60 s" style="color:#4b5563"
      >{fmtBytes(bytesIn())} in</span
    >
    <span title="Estimated bytes sent in last 60 s" style="color:#4b5563"
      >{fmtBytes(bytesOut())} out</span
    >

    <span style="margin-left:auto;display:flex;gap:6px">
      <button
        class="tooltip"
        data-tip="Show raw JSON under every value"
        onclick={() => (devMode = !devMode)}
        style="padding:2px 8px;border-radius:3px;border:1px solid #3f3f46;font-family:inherit;font-size:11px;cursor:pointer;background:{devMode
          ? '#1d4ed8'
          : '#27272a'};color:{devMode ? 'white' : '#d4d4d8'}"
      >
        Dev {devMode ? "ON" : "OFF"}
      </button>
      <a
        href="/"
        style="padding:2px 8px;border-radius:3px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;text-decoration:none;font-size:11px"
        >← Home</a
      >
    </span>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     IDENTITY
	     Your Nostr keypair and paired device list.
	     Private key is hidden by default — use "Show" only in a safe
	     environment. Paired devices are the only pubkeys allowed to
	     receive trigger events from this monitor.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">🔑 Identity</div>
    <div class="section-desc">
      Nostr keypair loaded from IndexedDB. The pubkey is your device's identity
      on the relay. Paired devices are viewers authorized to receive events and
      request footage.
    </div>
    <div class="section-body">
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Your bech32-encoded Nostr public key">pubkey (npub)</span
        >
        <span class="row-value"
          >{$identity ? toNpub($identity.pubkey) : "—"}</span
        >
        <span class="row-meta">
          <span class="badge" style="background:{badgeColor('LIVE')}">LIVE</span
          >
        </span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Raw hex pubkey — used internally in Nostr events"
          >pubkey (hex)</span
        >
        <span class="row-value" style="color:#6b7280"
          >{$identity?.pubkey ?? "—"}</span
        >
        <span class="row-meta">
          <span class="badge" style="background:{badgeColor('LIVE')}">LIVE</span
          >
        </span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Private key (nsec format). Never share this — it controls your identity."
          >privkey (nsec)</span
        >
        <span class="row-value">
          {#if showPrivkey && $identity}
            <span style="color:#ef4444">{toNsec($identity.privkey)}</span>
          {:else}
            <span style="color:#4b5563">••••••••••••••••</span>
          {/if}
        </span>
        <span class="row-meta">
          <button
            onclick={() => (showPrivkey = !showPrivkey)}
            style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
          >
            {showPrivkey ? "Hide" : "Show"}
          </button>
        </span>
      </div>
      {#each $pairedDevices as dev}
        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="Paired viewer device — events and footage requests from this pubkey are trusted"
            >paired: {dev.label}</span
          >
          <span class="row-value">{dev.pubkey}</span>
          <span class="row-meta">
            <span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            >
          </span>
        </div>
      {/each}
      {#if $pairedDevices.length === 0}
        <div class="row">
          <span class="row-label">paired devices</span><span
            class="row-value"
            style="color:#4b5563">none — pair via /pair</span
          >
        </div>
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     PAIRING
	     A device pair is one monitor + one viewer sharing pubkeys.
	     "Show QR" generates a senstry: URI for the monitor to display.
	     "Pair with Monitor" decodes a URI from another device and sends
	     a kind:5000 pair-ack. Paired pubkeys are stored in IDB.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">🔗 Pairing</div>
    <div class="section-desc">
      A paired device is a trusted pubkey stored in IDB. Monitor shows a QR
      (senstry: URI); viewer scans/pastes it to send a kind:5000 pair-ack and
      store the monitor's pubkey. Both sides must pair with each other before
      signaling or event delivery will work.
    </div>
    <div class="section-body">
      <!-- This device as monitor: show QR -->
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Encodes your pubkey + relay + label into a senstry: URI and renders it as a QR code for another device to scan."
          >show as monitor</span
        >
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <button
            onclick={generatePairQR}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
          >
            Generate QR
          </button>
          {#if pairUri}
            <button
              onclick={() => navigator.clipboard.writeText(pairUri)}
              style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
            >
              Copy URI
            </button>
          {/if}
        </span>
      </div>
      {#if pairQrSrc}
        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="Scan with the viewer device, or copy the URI above and paste into /pair/scan"
            >QR code</span
          >
          <span class="row-value">
            <img
              src={pairQrSrc}
              alt="Pairing QR"
              style="width:160px;border-radius:4px;background:white;padding:6px;display:block"
            />
            {#if devMode}
              <div
                style="margin-top:4px;color:#4b5563;font-size:10px;word-break:break-all"
              >
                {pairUri}
              </div>
            {/if}
          </span>
        </div>
      {/if}

      <!-- This device as viewer: paste URI to pair -->
      <div
        class="row"
        style="flex-direction:column;align-items:stretch;gap:4px"
      >
        <span
          class="row-label tooltip"
          data-tip="Paste a senstry: URI from a monitor device. Sends kind:5000 pair-ack to relay and stores the monitor's pubkey in IDB."
          >pair with monitor</span
        >
        <span
          style="display:flex;gap:4px;flex-wrap:wrap;align-items:flex-start;margin-top:4px"
        >
          <textarea
            bind:value={pairManualInput}
            rows="2"
            placeholder="senstry:…"
            class="dev-input"
            style="width:280px;resize:vertical;font-size:11px"
            title="Paste pairing URI from monitor"
          ></textarea>
          <button
            onclick={handleManualPair}
            disabled={!pairManualInput.trim()}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #1d4ed8;background:#1e293b;color:#93c5fd;cursor:pointer;font-family:inherit"
          >
            Pair
          </button>
        </span>
        {#if pairError}<div style="color:#ef4444;font-size:10px;padding:2px 0">
            {pairError}
          </div>{/if}
        {#if pairSuccess}<div
            style="color:#22c55e;font-size:10px;padding:2px 0"
          >
            {pairSuccess}
          </div>{/if}
      </div>

      <!-- Paired devices list -->
      {#each $pairedDevices as dev}
        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="Paired at {new Date(dev.addedAt).toLocaleString()}"
            >{dev.label}</span
          >
          <span class="row-value" style="color:#6b7280">{dev.pubkey}</span>
          <span class="row-meta">
            <span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            >
            <button
              onclick={() => unpairDevice(dev.pubkey)}
              style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit"
            >
              Remove
            </button>
          </span>
        </div>
      {/each}
      {#if $pairedDevices.length === 0}
        <div class="row">
          <span class="row-value" style="color:#4b5563">no paired devices</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     NOSTR — RELAY & SUBSCRIPTIONS
	     All communication with the Nostr relay goes through SimplePool.
	     Each subscription has a filter (kinds + #p tags). Signaling
	     events use kind 1059 (gift-wrapped DMs). Trigger events use
	     kind 5010.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">📡 Nostr — Relay & Subscriptions</div>
    <div class="section-desc">
      SimplePool manages one WebSocket per relay URL. Signaling uses kind 1059
      (NIP-59 gift wrap). Each row below is one open subscription filter. ×
      closes it. Stats show event count since open.
    </div>
    <div class="section-body">
      <div class="row">
        <span class="row-label tooltip" data-tip="Active relay WebSocket URLs"
          >relays</span
        >
        <span class="row-value">
          {#each getRelays() as r}<span class="sub-tag">{r}</span>{/each}
          {#if getRelays().length === 0}<span style="color:#4b5563"
              >none — set in /settings</span
            >{/if}
        </span>
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>

      {#each activeSubs as sub}
        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="Subscription ID — assigned internally, not sent to relay"
            >sub:{sub.id}</span
          >
          <span class="row-value">
            kinds:{JSON.stringify(sub.filter.kinds)}
            {#if (sub.filter as Record<string, unknown>)["#p"]}
              #p:{String((sub.filter as Record<string, unknown>)["#p"]).slice(
                0,
                16,
              )}…
            {/if}
            <span style="color:#4b5563">
              · {sub.eventCount} evts · opened {elapsed(sub.openedAt)}</span
            >
          </span>
          <span class="row-meta">
            <button
              onclick={() => {
                sub.close();
                activeSubs = getActiveSubs();
              }}
              style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit"
              >×</button
            >
          </span>
        </div>
      {/each}
      {#if activeSubs.length === 0}
        <div class="row">
          <span class="row-value" style="color:#4b5563"
            >no open subscriptions</span
          >
        </div>
      {/if}

      <!-- Manual subscribe -->
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Manually open a Nostr subscription for debugging. Comma-separate kinds."
          >add sub</span
        >
        <span style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          <input
            class="dev-input"
            bind:value={subKindInput}
            placeholder="kinds: 5010,5011"
            style="width:130px"
            title="Comma-separated kind numbers"
          />
          <input
            class="dev-input"
            bind:value={subPubkeyInput}
            placeholder="#p: hex pubkey (optional)"
            style="width:200px"
            title="Filter to events tagged with this pubkey"
          />
          <button
            onclick={addManualSub}
            style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
            >Sub</button
          >
        </span>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     WEBRTC SESSION
	     One RTCPeerConnection is shared for live video AND data channel.
	     Monitor is always offerer. Viewer receives via ondatachannel.
	     ICE state must reach "connected" and DC readyState "open" for
	     coverage map / segment requests to work.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">🔗 WebRTC Session</div>
    <div class="section-desc">
      Monitor creates RTCPeerConnection + data channel, sends offer via Nostr
      signaling. Viewer answers. ICE must reach "connected" and data channel
      "open" before coverage/segments work. Stats are an on-demand snapshot from
      pc.getStats().
    </div>
    <div class="section-body">
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Stream state managed by streamState store — idle → connecting → connected / failed"
          >stream state</span
        >
        <span
          class="row-value"
          style="color:{$streamState === 'connected'
            ? '#22c55e'
            : $streamState === 'connecting'
              ? '#fbbf24'
              : '#ef4444'}">{$streamState}</span
        >
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>
      <!-- Viewer side -->
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="ICE connection state reported by the viewer-side RTCPeerConnection"
          >viewer ICE</span
        >
        <span class="row-value">{viewerInfo.iceState ?? "—"}</span>
        <span class="row-meta">
          <button
            onclick={refreshRTCInfo}
            style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
            >Read</button
          >
        </span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Data channel readyState on viewer side — must be 'open' for segment/coverage requests"
          >viewer DC</span
        >
        <span class="row-value">{viewerInfo.dcState ?? "—"}</span>
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Number of incoming media track receivers (video + audio = 2 when connected)"
          >viewer tracks</span
        >
        <span class="row-value">{viewerInfo.trackCount}</span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Session ID negotiated during offer/answer — must match on both peers"
          >viewer session</span
        >
        <span class="row-value" style="color:#6b7280"
          >{viewerInfo.sessionId ?? "—"}</span
        >
      </div>
      <!-- Monitor side -->
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="ICE connection state on monitor side">monitor ICE</span
        >
        <span class="row-value">{monitorInfo.iceState ?? "—"}</span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Data channel readyState on monitor side — monitor creates the channel, viewer receives it"
          >monitor DC</span
        >
        <span class="row-value">{monitorInfo.dcState ?? "—"}</span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Number of outgoing media track senders (video + audio = 2 when streaming)"
          >monitor tracks</span
        >
        <span class="row-value">{monitorInfo.trackCount}</span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Remote MediaStream attached to the viewer's video element"
          >remote stream</span
        >
        <span class="row-value">
          {#if $remoteStream}
            {$remoteStream
              .getTracks()
              .map((t) => `${t.kind}(${t.readyState})`)
              .join(", ")}
          {:else}
            none
          {/if}
        </span>
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>
      <!-- Stats -->
      <div class="row" style="flex-wrap:wrap;gap:6px">
        <span
          class="row-label tooltip"
          data-tip="RTCStatsReport snapshot — shows bitrate, round-trip time, packet loss, codec info"
          >rtc stats</span
        >
        <span style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          <button
            onclick={readRTCStats}
            style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
            >Read</button
          >
          {#if rtcStats.length > 0}
            <button
              onclick={() => (rtcStatsExpanded = !rtcStatsExpanded)}
              style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
            >
              {rtcStatsExpanded
                ? "Collapse"
                : `Show ${rtcStats.length} entries`}
            </button>
          {/if}
        </span>
      </div>
      {#if rtcStatsExpanded}
        {#each rtcStats as stat}
          <div class="row" style="padding:3px 10px">
            <span class="row-label" style="color:#4b5563">{stat.type}</span>
            <span class="row-value row-raw" style="font-size:10px;color:#6b7280"
              >{JSON.stringify(stat, null, 2)}</span
            >
          </div>
        {/each}
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     INDEXEDDB STORAGE
	     Segments are 10-second audio chunks stored as Blobs.
	     Pinned segments are protected from eviction (they surround a
	     trigger event). Unpinned segments older than 60 s are
	     auto-deleted. Quota defaults to 500 MB.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">🗄️ IndexedDB Storage</div>
    <div class="section-desc">
      Three object stores: segments (audio chunks), events (trigger metadata),
      settings (key/value). "Pinned" segments are protected — they surround a
      trigger event (±30 s). Unpinned segments older than 60 s are auto-evicted.
      The quota is the total size limit before oldest-first eviction.
    </div>
    <div class="section-body">
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Total number of 10-second audio segments stored in IDB"
          >segments</span
        >
        <span class="row-value">{idb?.segmentCount ?? "—"}</span>
        <span class="row-meta">
          <span
            class="badge"
            style="background:{badgeColor(badge(idb?.readAt))}"
            >{badge(idb?.readAt)}</span
          >
          {#if idb}<span class="ts">{elapsed(idb.readAt)}</span>{/if}
          <button
            onclick={readIDB}
            style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
            >Read</button
          >
        </span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Total size of all segments on disk">segments size</span
        >
        <span class="row-value"
          >{idb?.segmentsMb ?? "—"} MB / {idb?.quotaMb ?? "—"} MB quota</span
        >
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Segments marked pinned=true — these won't be auto-evicted regardless of quota. They cover trigger events ±30 s."
          >pinned segs</span
        >
        <span class="row-value">{idb?.pinnedCount ?? "—"}</span>
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Trigger events stored in IDB (decrypted copies, metadata only)"
          >stored events</span
        >
        <span class="row-value">{idb?.eventCount ?? "—"}</span>
        <span class="row-meta">
          <span
            class="badge"
            style="background:{badgeColor(badge(idb?.readAt))}"
            >{badge(idb?.readAt)}</span
          >
          <span class="badge" style="background:{badgeColor('LIVE')}"
            >+LIVE</span
          >
        </span>
      </div>
      <div class="row" style="gap:6px">
        <span
          class="row-label tooltip"
          data-tip="Destructive IDB operations — cannot be undone"
          >danger zone</span
        >
        <span style="display:flex;gap:4px;flex-wrap:wrap">
          <button
            onclick={clearSegments}
            style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit"
            >Clear segments</button
          >
          <button
            onclick={clearEvents}
            style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit"
            >Clear events</button
          >
        </span>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     TRIGGERS & DETECTOR
	     Each TriggerConfig runs one AudioDetector instance in parallel
	     while the monitor is open. The detector fires only after audio
	     drops below threshold for cooldownMs (to capture full duration).
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">🎚️ Triggers & Detector</div>
    <div class="section-desc">
      One AudioDetector (Web Audio AnalyserNode + RMS) runs per enabled trigger.
      Events fire after audio drops below threshold for cooldownMs. Minimum
      duration filters out momentary spikes. Configure in /settings.
    </div>
    <div class="section-body">
      {#each $triggers as t}
        <div class="row">
          <span class="row-label tooltip" data-tip="Trigger ID: {t.id}"
            >{t.name}</span
          >
          <span class="row-value">
            {t.enabled ? "✓ enabled" : "✗ disabled"}
            · threshold: <b>{t.thresholdDb} dBFS</b>
            · cooldown: {t.cooldownMs}ms · min: {t.minDurationMs}ms
          </span>
          <span class="row-meta">
            <span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            >
          </span>
        </div>
        {#if devMode}
          <div class="row" style="padding:2px 10px">
            <span class="row-value row-raw">{JSON.stringify(t, null, 2)}</span>
          </div>
        {/if}
      {/each}
      {#if $triggers.length === 0}
        <div class="row">
          <span class="row-value" style="color:#4b5563"
            >no triggers — add in /settings</span
          >
        </div>
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     SETTINGS
	     App settings stored in IDB under the 'settings' object store
	     as key "app.settings". Segment quota stored separately under
	     key "segments.quotaBytes".
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">⚙️ Settings</div>
    <div class="section-desc">
      Stored in IDB settings store. Changes take effect after Save in /settings.
      relayUrl drives setRelays() in the Nostr pool. monitorLabel appears in
      trigger events.
    </div>
    <div class="section-body">
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="WebSocket URL of the Nostr relay used for signaling and event delivery"
          >relayUrl</span
        >
        <span class="row-value">{$settings.relayUrl}</span>
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Human-readable label included in trigger events (kind:5010) — identifies this monitor to the viewer"
          >monitorLabel</span
        >
        <span class="row-value">{$settings.monitorLabel}</span>
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     RECENT EVENTS
	     Trigger events received (viewer) or published (monitor).
	     Each entry is decrypted and stored in IDB. The 'raw' field
	     holds the original NIP-44 encrypted Nostr event.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">⚡ Recent Events ({$events.length})</div>
    <div class="section-desc">
      Decrypted trigger events stored in the 'events' IDB store and mirrored in
      the events Svelte store. 'raw' is the original encrypted kind:5010 event.
      Viewer receives these via Nostr subscription. Monitor writes them locally
      after publishing.
    </div>
    <div class="section-body">
      {#each $events.slice(0, 10) as evt}
        <div class="row">
          <span class="row-label tooltip" data-tip="Event ID: {evt.id}"
            >{evt.type} · {fmtUnix(evt.created_at)}</span
          >
          <span class="row-value">
            {evt.monitorLabel}
            {#if evt.data.peakDb !== undefined}
              · {evt.data.peakDb} dBFS{/if}
            {#if evt.data.durationMs !== undefined}
              · {evt.data.durationMs}ms{/if}
            {#if evt.data.triggerName}
              · [{evt.data.triggerName as string}]{/if}
          </span>
          <span class="row-meta">
            <span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            >
          </span>
        </div>
        {#if devMode}
          <div class="row" style="padding:2px 10px">
            <span class="row-value row-raw">{JSON.stringify(evt, null, 2)}</span
            >
          </div>
        {/if}
      {/each}
      {#if $events.length === 0}
        <div class="row">
          <span class="row-value" style="color:#4b5563">no events yet</span>
        </div>
      {/if}
      {#if $events.length > 10}
        <div class="row">
          <span class="row-value" style="color:#4b5563"
            >…and {$events.length - 10} more in /viewer/events</span
          >
        </div>
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     COVERAGE MAP
	     Fetched from the monitor on demand over the WebRTC data channel.
	     The monitor scans its IDB segments store and returns merged
	     time ranges. Requires an open data channel (viewer must be
	     connected to monitor).
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">📼 Coverage Map</div>
    <div class="section-desc">
      Fetched from monitor's IDB over the WebRTC data channel (coverage-request
      → coverage-map). Shows which unix-second ranges have stored audio
      segments. Requires DC readyState = "open". The timeline scrubber uses this
      to draw coverage bars.
    </div>
    <div class="section-body">
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Merged time ranges where monitor has stored audio segments"
          >ranges</span
        >
        <span class="row-value">
          {#if coverage}
            {#if coverage.length === 0}
              <span style="color:#4b5563">empty — no segments on monitor</span>
            {:else}
              {#each coverage as [s, e]}
                <span class="sub-tag">{fmtUnix(s)}–{fmtUnix(e)} ({e - s}s)</span
                >
              {/each}
            {/if}
          {:else}
            <span style="color:#4b5563">not fetched</span>
          {/if}
          {#if coverageError}<span style="color:#ef4444">
              ✗ {coverageError}</span
            >{/if}
        </span>
        <span class="row-meta">
          {#if coverage}<span
              class="badge"
              style="background:{badgeColor(badge(coverageReadAt))}"
              >{badge(coverageReadAt)}</span
            >{/if}
          {#if coverageReadAt}<span class="ts">{elapsed(coverageReadAt)}</span
            >{/if}
          <button
            onclick={readCoverage}
            style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
            >Read</button
          >
        </span>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     MONITOR MODE
	     Full monitor implementation running on this device.
	     Starts camera/mic, records 10s audio segments to IDB, runs
	     one AudioDetector per enabled trigger. Must be armed to
	     publish trigger events. /monitor page mirrors this.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">📷 Monitor Mode</div>
    <div class="section-desc">
      Run this device as a monitor. Camera+mic → MediaRecorder (audio-only, 10s
      chunks) → IDB segments. AudioDetector (RMS threshold) runs per enabled
      trigger. Arm to publish kind:5010 events to relay and store locally.
      /monitor uses this exact logic — dev page is the canonical reference.
    </div>
    <div class="section-body">
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Start requests camera+mic. Stop closes all tracks, MediaRecorder, AudioContexts, and WebRTC signaling."
          >controls</span
        >
        <span style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          {#if !monitorRunning}
            <button
              onclick={startMonitorDev}
              style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #16a34a;background:#14532d;color:#bbf7d0;cursor:pointer;font-family:inherit"
            >
              ▶ Start Monitor
            </button>
          {:else}
            <button
              onclick={stopMonitorDev}
              style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit"
            >
              ■ Stop Monitor
            </button>
            <button
              onclick={() => (monitorArmed = !monitorArmed)}
              style="padding:2px 8px;border-radius:3px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;border:2px solid {monitorArmed
                ? '#dc2626'
                : '#16a34a'};background:{monitorArmed
                ? '#450a0a'
                : '#14532d'};color:{monitorArmed ? '#fca5a5' : '#bbf7d0'}"
            >
              {monitorArmed ? "🔴 DISARM" : "🟢 ARM"}
            </button>
            <button
              onclick={manualFireTrigger}
              disabled={!monitorArmed}
              style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:{monitorArmed
                ? '#d4d4d8'
                : '#52525b'};cursor:{monitorArmed
                ? 'pointer'
                : 'not-allowed'};font-family:inherit"
              title="Fire a synthetic trigger without audio — tests the publish+IDB flow"
            >
              ⚡ Fire Test Trigger
            </button>
          {/if}
        </span>
      </div>

      {#if monitorError}
        <div class="row">
          <span class="row-label" style="color:#ef4444">error</span>
          <span class="row-value" style="color:#ef4444">{monitorError}</span>
        </div>
      {/if}

      {#if monitorRunning}
        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="Live camera preview. Video is never stored — only audio feeds the MediaRecorder and detectors."
            >camera</span
          >
          <span class="row-value">
            <video
              bind:this={monitorVideoEl}
              autoplay
              muted
              playsinline
              style="width:220px;max-width:100%;border-radius:4px;background:#000;display:block"
            ></video>
          </span>
          <span class="row-meta"
            ><span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            ></span
          >
        </div>

        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="RMS level from AnalyserNode fftSize=1024. Detectors fire when this exceeds a trigger's thresholdDb for ≥minDurationMs."
            >dBFS</span
          >
          <span
            class="row-value"
            style="display:flex;align-items:center;gap:8px;flex:1"
          >
            <code
              style="font-weight:700;min-width:64px;color:{isFinite(
                monitorPeakDb,
              ) &&
              $triggers.some((t) => t.enabled && monitorPeakDb > t.thresholdDb)
                ? '#ef4444'
                : '#22c55e'}"
            >
              {isFinite(monitorPeakDb) ? monitorPeakDb.toFixed(1) : "—"} dB
            </code>
            <span
              style="flex:1;height:8px;background:#27272a;border-radius:4px;overflow:hidden;min-width:80px"
            >
              <span
                style="display:block;height:100%;border-radius:4px;transition:width 75ms linear;width:{Math.max(
                  0,
                  Math.min(100, (monitorPeakDb + 60) * (100 / 60)),
                )}%;background:{isFinite(monitorPeakDb) &&
                $triggers.some(
                  (t) => t.enabled && monitorPeakDb > t.thresholdDb,
                )
                  ? '#ef4444'
                  : '#22c55e'}"
              ></span>
            </span>
          </span>
          <span class="row-meta"
            ><span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            ></span
          >
        </div>

        {#each $triggers.filter((t) => t.enabled) as t}
          <div class="row" style="padding:3px 10px">
            <span
              class="row-label tooltip"
              data-tip="Fires after ≥{t.minDurationMs}ms above threshold, then {t.cooldownMs}ms cooldown before closing event."
              style="color:#52525b">↳ {t.name}</span
            >
            <span class="row-value">
              <code>{t.thresholdDb} dBFS</code>
              <span
                style="margin-left:8px;color:{isFinite(monitorPeakDb) &&
                monitorPeakDb > t.thresholdDb
                  ? '#ef4444'
                  : '#4b5563'}"
              >
                {isFinite(monitorPeakDb) && monitorPeakDb > t.thresholdDb
                  ? "▲ OVER"
                  : "▼ below"}
              </span>
            </span>
          </div>
        {/each}

        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="Armed = detectors publish kind:5010 events. Disarmed = meter still runs but events are suppressed."
            >armed</span
          >
          <span
            class="row-value"
            style="font-weight:700;color:{monitorArmed ? '#ef4444' : '#22c55e'}"
          >
            {monitorArmed
              ? "ARMED — events publish"
              : "DISARMED — events suppressed"}
          </span>
          <span class="row-meta"
            ><span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            ></span
          >
        </div>

        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="MediaRecorder state and MIME. Audio-only stream, 10s timeslice. Each ondataavailable blob → saveSegment() → IDB."
            >recorder</span
          >
          <span class="row-value"
            >{monitorRecorder?.state ?? "—"} · {monitorMimeType || "—"}</span
          >
          <span class="row-meta"
            ><span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            ></span
          >
        </div>

        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="Segments written to IDB this session. Unpinned auto-evict after {PRE_ROLL_S *
              2}s or quota breach. Pinned = within ±{PRE_ROLL_S}s of a trigger."
            >segments written</span
          >
          <span class="row-value">{monitorSegmentsWritten}</span>
          <span class="row-meta">
            <span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            >
            <button
              onclick={refreshMonitorCoverage}
              style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
            >
              Refresh
            </button>
          </span>
        </div>

        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="Merged coverage ranges from local IDB — no WebRTC needed. Monitor is source of truth. Viewer fetches this same data via data channel."
            >local coverage</span
          >
          <span class="row-value">
            {#if monitorLocalCoverage.length === 0}
              <span style="color:#4b5563">no segments yet</span>
            {:else}
              {#each monitorLocalCoverage as [s, e]}
                <span class="sub-tag"
                  >{fmtUnix(s)}–{fmtUnix(e)}
                  <span style="color:#52525b">({e - s}s)</span></span
                >
              {/each}
            {/if}
          </span>
        </div>

        <div class="row">
          <span
            class="row-label tooltip"
            data-tip="ICE/DC state for viewers connecting to this monitor. 'connected' = a viewer is live-streaming. Tracks = media senders (video+audio)."
            >WebRTC (inbound)</span
          >
          <span class="row-value"
            >ICE: <b>{monitorInfo.iceState ?? "no session"}</b> · DC: {monitorInfo.dcState ??
              "—"} · {monitorInfo.trackCount} track{monitorInfo.trackCount !== 1
              ? "s"
              : ""}</span
          >
          <span class="row-meta"
            ><span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            ></span
          >
        </div>

        {#if monitorSessionEvents.length > 0}
          <div class="row" style="flex-direction:column;align-items:stretch">
            <span
              class="row-label tooltip"
              data-tip="Trigger events fired and published this session. Each was pinRange()d in IDB and published as kind:5010 to relay."
              >session events ({monitorSessionEvents.length})</span
            >
            <div style="margin-top:4px">
              {#each monitorSessionEvents as e}
                <div
                  class="row"
                  style="padding:3px 10px;gap:6px;align-items:baseline"
                >
                  <span
                    style="display:flex;flex-direction:column;gap:1px;flex-shrink:0"
                  >
                    <span style="color:#71717a;font-size:10px"
                      >{fmtUnix(e.ts)}</span
                    >
                    <button
                      onclick={() => (viewerApiTime = String(e.ts))}
                      title="Click to copy unix timestamp to segment API input"
                      style="font-family:inherit;font-size:9px;color:#3b82f6;background:none;border:none;padding:0;cursor:pointer;text-align:left"
                    >
                      {e.ts}
                    </button>
                  </span>
                  <b style="color:#fbbf24;flex-shrink:0">{e.triggerName}</b>
                  <span style="color:#d4d4d8"
                    >{e.peakDb.toFixed(1)} dBFS · {e.durationMs}ms</span
                  >
                  <span style="color:#4b5563;font-size:10px;flex:1"
                    >id:{e.eventId.slice(0, 12)}</span
                  >
                  <button
                    onclick={() => deleteEvent(e.eventId)}
                    style="padding:0 5px;border-radius:3px;font-size:10px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit;flex-shrink:0"
                    >✕</button
                  >
                </div>
              {/each}
            </div>
          </div>
          {#if devMode && monitorLastNostrEvent}
            <div class="row" style="padding:2px 10px">
              <span class="row-label" style="color:#4b5563"
                >last nostr event</span
              >
              <pre class="row-raw" style="flex:1;margin:0">{JSON.stringify(
                  monitorLastNostrEvent,
                  null,
                  2,
                )}</pre>
            </div>
          {/if}
        {:else if monitorArmed}
          <div class="row">
            <span class="row-value" style="color:#4b5563"
              >armed — waiting for first detection…</span
            >
          </div>
        {/if}
      {/if}

      <!-- Local playback always visible — reads IDB directly, no WebRTC or active recording needed -->
      <div class="row" style="flex-direction:column;align-items:stretch">
        <span
          class="row-label tooltip"
          data-tip="localMode=true: getCoverageMap() reads local IDB, getSegmentAt() fetches blobs locally. No WebRTC or paired device required — the monitor plays its own footage."
          >local playback</span
        >
        <div style="margin-top:6px;padding:0 4px">
          <TimelineView events={$events} localMode={true} />
        </div>
      </div>
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     VIEWER MODE
	     Connect to a paired monitor. ICE must reach "connected" and
	     data channel must be "open" for coverage map + segment
	     requests. Timeline scrubber + player fully functional here.
	     /viewer mirrors this.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">👁️ Viewer Mode</div>
    <div class="section-desc">
      Connect to a paired monitor over WebRTC. ensureConnection = idempotent
      (safe to call anytime, reuses existing session). requestLiveView =
      force-closes first (explicit retry only). ICE "connected" + DC "open"
      required before coverage map or segment requests will work.
    </div>
    <div class="section-body">
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Connect: safe, reuses existing session. Force Reconnect: closes current PC first. Disconnect: stops viewer + clears remoteStream store."
          >connection</span
        >
        <span style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          <button
            onclick={connectViewerDev}
            disabled={viewerConnecting}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #1d4ed8;background:{$streamState ===
            'connected'
              ? '#1d4ed8'
              : '#1e293b'};color:#93c5fd;cursor:pointer;font-family:inherit"
          >
            {viewerConnecting ? "Connecting…" : "▶ Connect"}
          </button>
          <button
            onclick={forceReconnectViewerDev}
            disabled={viewerConnecting}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #ca8a04;background:#1c1207;color:#fde68a;cursor:pointer;font-family:inherit"
            title="Closes the current RTCPeerConnection and creates a fresh one — use only if stuck"
          >
            ⚡ Force Reconnect
          </button>
          <button
            onclick={disconnectViewerDev}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit"
          >
            ■ Disconnect
          </button>
        </span>
      </div>

      {#if viewerError}
        <div class="row">
          <span class="row-label" style="color:#ef4444">error</span>
          <span class="row-value" style="color:#ef4444">{viewerError}</span>
        </div>
      {/if}

      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="ICE connection state. Must reach 'connected' for live video + data channel operations."
          >ICE state</span
        >
        <span
          class="row-value"
          style="color:{viewerInfo.iceState === 'connected'
            ? '#22c55e'
            : viewerInfo.iceState === 'checking'
              ? '#fbbf24'
              : '#9ca3af'}">{viewerInfo.iceState ?? "—"}</span
        >
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Data channel readyState. Must be 'open' before requestCoverageMap() or requestSegment() will succeed."
          >DC state</span
        >
        <span
          class="row-value"
          style="color:{viewerInfo.dcState === 'open' ? '#22c55e' : '#9ca3af'}"
          >{viewerInfo.dcState ?? "—"}</span
        >
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Session UUID assigned by the viewer during ensureConnection — embedded in every signaling message to route back to the right PC."
          >session ID</span
        >
        <span class="row-value" style="color:#6b7280"
          >{viewerInfo.sessionId ?? "—"}</span
        >
      </div>
      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="streamState store — idle → connecting → connected / failed. Drives the status badge and retry button on /viewer."
          >stream state</span
        >
        <span
          class="row-value"
          style="color:{$streamState === 'connected'
            ? '#22c55e'
            : $streamState === 'connecting'
              ? '#fbbf24'
              : '#9ca3af'}">{$streamState}</span
        >
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>

      <div class="row">
        <span
          class="row-label tooltip"
          data-tip="Incoming WebRTC video+audio stream. srcObject is set reactively via $effect when the remoteStream store updates (onTrack callback)."
          >live video</span
        >
        <span class="row-value">
          <div style="position:relative;width:240px;max-width:100%">
            <video
              bind:this={viewerVideoEl}
              autoplay
              playsinline
              style="width:100%;border-radius:4px;background:#000;min-height:60px;display:block"
            ></video>
            {#if !viewerNearLive}
              <div
                style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.75);border-radius:4px;color:#9ca3af;font-size:11px;text-align:center;padding:8px"
              >
                historical playback<br />live stream muted
              </div>
            {/if}
          </div>
          <div style="color:#4b5563;font-size:10px;margin-top:3px">
            {#if $remoteStream}
              {$remoteStream
                .getTracks()
                .map((t) => `${t.kind}(${t.readyState})`)
                .join(" · ")}
            {:else}
              no stream yet
            {/if}
          </div>
        </span>
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>

      {#if viewerRunning}
        <div class="row" style="flex-direction:column;align-items:stretch">
          <span
            class="row-label tooltip"
            data-tip="TimelineView: scrubber shows coverage bars + trigger event markers. Player fetches audio segments from monitor via data channel on seek. Scroll to zoom."
            >timeline</span
          >
          <div style="margin-top:6px;padding:0 4px">
            <TimelineView
              events={$events}
              onNearLiveChange={(nl) => (viewerNearLive = nl)}
            />
          </div>
        </div>
      {:else}
        <div class="row">
          <span class="row-label">timeline</span>
          <span class="row-value" style="color:#4b5563"
            >connect first to enable timeline</span
          >
        </div>
      {/if}

      <!-- Manual API rows -->
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Calls requestCoverageMap() over WebRTC data channel — the same function the timeline uses automatically. Requires DC state = open."
          >coverage API</span
        >
        <span style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          <button
            onclick={apiRequestCoverage}
            disabled={viewerApiLoading}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #1d4ed8;background:#1e293b;color:{viewerApiLoading
              ? '#4b5563'
              : '#93c5fd'};cursor:{viewerApiLoading
              ? 'not-allowed'
              : 'pointer'};font-family:inherit"
          >
            Request Coverage
          </button>
        </span>
      </div>
      {#if viewerApiCoverageResult}
        <div class="row">
          <span class="row-label" style="color:#52525b">↳ result</span>
          <span class="row-value" style="color:#d4d4d8;font-size:10px"
            >{viewerApiCoverageResult}</span
          >
        </div>
      {/if}

      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Request a segment by unix timestamp. WebRTC fetch = data channel request to monitor. Local IDB = reads this device's own segments directly (no connection needed)."
          >segment API</span
        >
        <span style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          <input
            bind:value={viewerApiTime}
            placeholder="unix timestamp"
            class="dev-input"
            style="width:120px"
            title="Unix timestamp (seconds) to seek to — e.g. Math.floor(Date.now()/1000)"
          />
          <button
            onclick={apiRequestSegment}
            disabled={viewerApiLoading}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #1d4ed8;background:#1e293b;color:{viewerApiLoading
              ? '#4b5563'
              : '#93c5fd'};cursor:{viewerApiLoading
              ? 'not-allowed'
              : 'pointer'};font-family:inherit"
          >
            WebRTC fetch
          </button>
          <button
            onclick={apiLocalSegment}
            disabled={viewerApiLoading}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #16a34a;background:#14532d;color:{viewerApiLoading
              ? '#4b5563'
              : '#bbf7d0'};cursor:{viewerApiLoading
              ? 'not-allowed'
              : 'pointer'};font-family:inherit"
          >
            Local IDB
          </button>
        </span>
      </div>
      {#if viewerApiSegmentResult}
        <div class="row">
          <span class="row-label" style="color:#52525b">↳ result</span>
          <span class="row-value" style="color:#d4d4d8;font-size:10px"
            >{viewerApiSegmentResult}</span
          >
        </div>
      {/if}
      {#if viewerApiSegmentBlobUrl}
        <div
          class="row"
          style="flex-direction:column;align-items:stretch;gap:4px"
        >
          <span
            class="row-label tooltip"
            data-tip="Decoded audio from the fetched segment blob — playable in browser. Object URL is revoked on next fetch."
            >↳ audio</span
          >
          <audio controls style="width:100%;margin-top:4px">
            <source
              src={viewerApiSegmentBlobUrl}
              type={viewerApiSegmentMimeType}
            />
          </audio>
        </div>
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     EVENT LOG
	     Trigger events from IDB with full calendar UI.
	     Monitor writes events to its own IDB directly (no RTC).
	     Viewer receives via Nostr subscription + IDB cache.
	     Per-event delete removes from IDB and the reactive store.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">📅 Event Log ({$events.length})</div>
    <div class="section-desc">
      Two modes. Local (IDB): reads this device's own stored events — works
      offline, no relay needed. Viewer (relay): fetches events from the relay
      encrypted to your pubkey from a specific monitor. Both share the time
      range below.
    </div>
    <div class="section-body">
      <!-- Shared time range -->
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Time range shared by both Local and Viewer fetch below."
          >range</span
        >
        <span style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
          {#each [["7d", "Last 7 days"], ["30d", "Last 30 days"]] as [r, label]}
            <button
              onclick={() => (eventsLoadRange = r as "7d" | "30d")}
              style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;cursor:pointer;font-family:inherit;background:{eventsLoadRange ===
              r
                ? '#1d4ed8'
                : '#27272a'};color:{eventsLoadRange === r
                ? 'white'
                : '#d4d4d8'}"
            >
              {label}
            </button>
          {/each}
          <button
            onclick={() => (eventsLoadRange = "custom")}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;cursor:pointer;font-family:inherit;background:{eventsLoadRange ===
            'custom'
              ? '#1d4ed8'
              : '#27272a'};color:{eventsLoadRange === 'custom'
              ? 'white'
              : '#d4d4d8'}"
          >
            Custom…
          </button>
        </span>
      </div>
      {#if eventsLoadRange === "custom"}
        <div class="row" style="flex-wrap:wrap;gap:6px">
          <span
            class="row-label tooltip"
            data-tip="Custom date range — converted to unix timestamps"
            >custom range</span
          >
          <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <input
              type="date"
              bind:value={eventsCustomFrom}
              class="dev-input"
            />
            <span style="color:#4b5563">–</span>
            <input type="date" bind:value={eventsCustomTo} class="dev-input" />
          </span>
        </div>
      {/if}

      <!-- ── LOCAL (IDB) ── -->
      <div class="row" style="background:#111118;padding:4px 10px">
        <span
          style="color:#a1a1aa;font-size:10px;font-weight:700;letter-spacing:.06em"
          >LOCAL (IDB) — monitor's own events</span
        >
      </div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Reads events from local IDB for the selected range. Monitor writes here directly after publishing — works offline, no relay or WebRTC needed."
          >load local</span
        >
        <span style="display:flex;gap:4px;align-items:center">
          <button
            onclick={() => loadEventsDev(eventsLoadRange)}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #16a34a;background:#14532d;color:#bbf7d0;cursor:pointer;font-family:inherit"
          >
            Load from IDB
          </button>
          {#if eventsLoaded}<span style="color:#22c55e;font-size:10px"
              >{$events.length} loaded</span
            >{/if}
        </span>
        {#if eventsLoaded}<span class="row-meta"
            ><span class="badge" style="background:{badgeColor('LIVE')}"
              >LIVE</span
            ></span
          >{/if}
      </div>

      <!-- ── VIEWER (relay fetch) ── -->
      <div
        class="row"
        style="background:#111118;padding:4px 10px;border-top:1px solid #27272a;margin-top:4px"
      >
        <span
          style="color:#a1a1aa;font-size:10px;font-weight:700;letter-spacing:.06em"
          >VIEWER (relay) — fetch from monitor</span
        >
      </div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Monitor whose events to fetch. Events are kind:5010 published by the monitor and encrypted to your pubkey. Filter: authors=[monitorPubkey], #p=[yourPubkey]."
          >monitor</span
        >
        <span
          style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;flex:1"
        >
          {#if $pairedDevices.length > 0}
            <select
              onchange={(e) =>
                (viewerEventsMonitorKey = (e.target as HTMLSelectElement)
                  .value)}
              class="dev-input"
              style="max-width:220px"
            >
              {#each $pairedDevices as dev}
                <option
                  value={dev.pubkey}
                  selected={viewerEventsMonitorKey === dev.pubkey}
                  >{dev.label} ({dev.pubkey.slice(0, 12)}…)</option
                >
              {/each}
              <option value="">— manual —</option>
            </select>
          {/if}
          <input
            bind:value={viewerEventsMonitorKey}
            placeholder="monitor hex pubkey"
            class="dev-input"
            style="flex:1;min-width:200px;max-width:340px"
          />
        </span>
      </div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span
          class="row-label tooltip"
          data-tip="Opens a relay subscription with since/until + authors filter. Calls upsertEvent() to decrypt each received event and store it in IDB. Completes at EOSE then stays open for new arrivals."
          >fetch from relay</span
        >
        <span style="display:flex;gap:4px;align-items:center">
          <button
            onclick={fetchViewerEvents}
            disabled={viewerEventsFetching || !viewerEventsMonitorKey}
            style="padding:2px 8px;border-radius:3px;font-size:11px;border:1px solid #1d4ed8;background:#1e293b;color:{viewerEventsFetching ||
            !viewerEventsMonitorKey
              ? '#4b5563'
              : '#93c5fd'};cursor:{viewerEventsFetching ||
            !viewerEventsMonitorKey
              ? 'not-allowed'
              : 'pointer'};font-family:inherit"
          >
            {viewerEventsFetching ? "Fetching…" : "Fetch Events"}
          </button>
          {#if viewerEventsReceived > 0}
            <span style="color:#22c55e;font-size:10px"
              >{viewerEventsReceived} received</span
            >
          {/if}
          {#if viewerEventsFetching}
            <span style="color:#fbbf24;font-size:10px">waiting for EOSE…</span>
          {/if}
          {#if viewerEventsSub && !viewerEventsFetching}
            <span class="badge" style="background:#a78bfa">+RELAY</span>
          {/if}
        </span>
      </div>
      {#if viewerEventsError}
        <div class="row">
          <span class="row-label" style="color:#ef4444">error</span><span
            class="row-value"
            style="color:#ef4444">{viewerEventsError}</span
          >
        </div>
      {/if}

      <!-- Combined total -->
      <div class="row" style="border-top:1px solid #27272a;margin-top:2px">
        <span
          class="row-label tooltip"
          data-tip="All events in the reactive store — from IDB load + relay fetch combined. Sorted newest-first."
          >total</span
        >
        <span class="row-value"
          >{$events.length} events{!eventsLoaded && !viewerEventsReceived
            ? " — use Load or Fetch above"
            : ""}</span
        >
        <span class="row-meta"
          ><span class="badge" style="background:{badgeColor('LIVE')}"
            >LIVE</span
          ></span
        >
      </div>

      {#if $events.length > 0}
        <div class="row" style="flex-direction:column;align-items:stretch">
          <span
            class="row-label tooltip"
            data-tip="Each row is one IDB event. ✕ deletes from IDB and the store. devMode shows full JSON."
            >events (IDB)</span
          >
          <div style="margin-top:4px">
            {#each $events.slice(0, 20) as evt}
              <div
                class="row"
                style="padding:3px 10px;gap:6px;align-items:baseline"
              >
                <span
                  style="display:flex;flex-direction:column;gap:1px;flex-shrink:0;width:110px"
                >
                  <span style="color:#71717a;font-size:10px"
                    >{fmtUnix(evt.created_at)}</span
                  >
                  <button
                    onclick={() => (viewerApiTime = String(evt.created_at))}
                    title="Click to copy unix timestamp to segment API input"
                    style="font-family:inherit;font-size:9px;color:#3b82f6;background:none;border:none;padding:0;cursor:pointer;text-align:left"
                  >
                    {evt.created_at}
                  </button>
                </span>
                <span
                  class="sub-tag"
                  style="background:#1c1207;border-color:#713f12;color:#fde68a;flex-shrink:0"
                  >{evt.type}</span
                >
                <span
                  style="flex:1;color:#d4d4d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                  >{evt.monitorLabel}</span
                >
                {#if evt.data.peakDb !== undefined}
                  <span style="color:#6b7280;font-size:10px;flex-shrink:0"
                    >{String(evt.data.peakDb)} dB</span
                  >
                {/if}
                {#if evt.data.durationMs !== undefined}
                  <span style="color:#6b7280;font-size:10px;flex-shrink:0"
                    >{String(evt.data.durationMs)}ms</span
                  >
                {/if}
                <button
                  onclick={() => deleteEvent(evt.id)}
                  style="padding:0 5px;border-radius:3px;font-size:10px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit;flex-shrink:0"
                  >✕</button
                >
              </div>
              {#if devMode}
                <div
                  style="padding:2px 10px 4px;background:#111118;border-bottom:1px solid #1c1c21"
                >
                  <pre
                    style="font-size:9px;color:#6b7280;white-space:pre-wrap;margin:0;max-height:80px;overflow-y:auto">{JSON.stringify(
                      evt,
                      null,
                      2,
                    )}</pre>
                </div>
              {/if}
            {/each}
            {#if $events.length > 20}
              <div class="row" style="padding:4px 10px">
                <span style="color:#4b5563"
                  >…and {$events.length - 20} more</span
                >
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if eventsLoaded}
        <div style="border-top:1px solid #27272a;margin-top:4px">
          <CalendarRoot allEvents={$events} />
        </div>
      {:else}
        <div class="row">
          <span class="row-value" style="color:#4b5563"
            >Load a range above to show the calendar</span
          >
        </div>
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     NOSTR EVENT TESTER
	     Manually publish raw Nostr events for testing. The event is
	     signed with your identity privkey and sent to the configured
	     relay. Use this to test if the relay is accepting events and
	     if subscriptions are receiving them.
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">🧪 Nostr Event Tester</div>
    <div class="section-desc">
      Publish a raw Nostr event signed with your identity. Use to verify relay
      connectivity and subscription delivery. The event content is NOT encrypted
      here — use only test data.
    </div>
    <div class="section-body">
      <div class="row" style="flex-wrap:wrap;gap:6px">
        <span
          class="row-label tooltip"
          data-tip="Nostr event kind number (integer)">kind</span
        >
        <input
          class="dev-input"
          bind:value={publishKind}
          style="width:70px"
          placeholder="5010"
          title="Event kind (integer)"
        />
      </div>
      <div class="row" style="flex-wrap:wrap;gap:6px">
        <span
          class="row-label tooltip"
          data-tip="Event content — plain text or JSON. NOT encrypted."
          >content (plain)</span
        >
        <input
          class="dev-input"
          bind:value={publishContent}
          style="width:280px"
          placeholder="&#123;&quot;test&quot;:true&#125;"
          title="Event content string"
        />
        <button
          onclick={sendTestEvent}
          style="padding:1px 7px;border-radius:3px;font-size:11px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
          >Publish</button
        >
      </div>
      {#if publishResult}
        <div class="row">
          <span class="row-label">result</span>
          <span class="row-value" style="color:#22c55e">{publishResult}</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- ═══════════════════════════════════════════════════════════════
	     EVENT LOG
	     All instrumented in/out messages from Nostr and WebRTC
	     signaling. Rows are newest-first. Click a row to expand the
	     raw JSON payload. Filter by source (nostr/rtc/idb/app) or
	     direction (in/out/info/warn/error).
	     Bandwidth counters at the top of the page are derived from
	     this log (last 60 s window).
	     ═══════════════════════════════════════════════════════════════ -->
  <div class="section">
    <div class="section-head">
      📋 Event Log ({$debugLog.length})
      <span style="margin-left:auto;display:flex;gap:4px">
        <!-- Source filter -->
        {#each ["all", "nostr", "rtc", "idb", "detector", "app"] as src}
          <button
            onclick={() => (logFilterSource = src as LogSource | "all")}
            style="padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid #3f3f46;cursor:pointer;font-family:inherit;background:{logFilterSource ===
            src
              ? '#1d4ed8'
              : '#27272a'};color:{logFilterSource === src
              ? 'white'
              : '#9ca3af'}"
          >
            {src}
          </button>
        {/each}
        <span style="color:#27272a">|</span>
        <!-- Dir filter -->
        {#each ["all", "in", "out", "info", "warn", "error"] as d}
          <button
            onclick={() => (logFilterDir = d as LogDir | "all")}
            style="padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid #3f3f46;cursor:pointer;font-family:inherit;background:{logFilterDir ===
            d
              ? '#1d4ed8'
              : '#27272a'};color:{logFilterDir === d ? 'white' : '#9ca3af'}"
          >
            {d}
          </button>
        {/each}
        <span style="color:#27272a">|</span>
        <button
          onclick={copyLogs}
          style="padding:1px 7px;border-radius:3px;font-size:10px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
          >copy</button
        >
        <button
          onclick={exportLogs}
          style="padding:1px 7px;border-radius:3px;font-size:10px;border:1px solid #3f3f46;background:#27272a;color:#d4d4d8;cursor:pointer;font-family:inherit"
          >export</button
        >
        <button
          onclick={clearLog}
          style="padding:1px 7px;border-radius:3px;font-size:10px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;cursor:pointer;font-family:inherit"
          >clear</button
        >
      </span>
    </div>
    <div class="section-desc">
      Newest-first. Click row to expand raw JSON payload. Green = inbound, blue
      = outbound, grey = info. Nostr events include the full event JSON; RTC
      entries show the signaling message content. Bandwidth counters (header)
      count in/out rows from last 60 s.
    </div>
    <div style="max-height:380px;overflow-y:auto">
      {#each filteredLog as entry (entry.id)}
        <div
          class="log-row"
          role="button"
          tabindex="0"
          onclick={() =>
            (logExpandedId = logExpandedId === entry.id ? null : entry.id)}
          onkeydown={(e) =>
            e.key === "Enter" &&
            (logExpandedId = logExpandedId === entry.id ? null : entry.id)}
        >
          <span class="log-ts">{fmtTime(entry.ts)}</span>
          <span class="log-dir" style="color:{dirColor(entry.dir)}"
            >{entry.dir.toUpperCase()}</span
          >
          <span class="log-src" style="color:{srcColor(entry.source)}"
            >[{entry.source}]</span
          >
          <span class="log-label">{entry.label}</span>
          <span class="log-bytes"
            >{entry.bytes ? fmtBytes(entry.bytes) : ""}</span
          >
        </div>
        {#if logExpandedId === entry.id && entry.raw}
          <div
            style="padding:4px 10px 6px 148px;background:#111118;border-bottom:1px solid #1c1c21"
          >
            <pre
              style="font-size:10px;color:#6b7280;white-space:pre-wrap;margin:0;max-height:200px;overflow-y:auto">{entry.raw}</pre>
          </div>
        {/if}
      {/each}
      {#if filteredLog.length === 0}
        <div style="padding:12px 10px;color:#4b5563;text-align:center">
          No log entries match filter
        </div>
      {/if}
    </div>
  </div>

  <div style="padding:12px;color:#3f3f46;font-size:10px;text-align:center">
    Senstry Dev Panel — <a href="/" style="color:#52525b">← Back to app</a>
  </div>
</div>

<style>
  .dev {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    background: #0f0f14;
    color: #e5e7eb;
    min-height: 100vh;
  }
  .section {
    border: 1px solid #27272a;
    margin: 8px;
    border-radius: 6px;
    overflow: hidden;
  }
  .section-head {
    background: #18181b;
    padding: 6px 10px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #a1a1aa;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .section-desc {
    background: #18181b;
    padding: 2px 10px 6px;
    font-size: 10px;
    color: #52525b;
    border-bottom: 1px solid #27272a;
  }
  .section-body {
    padding: 0;
  }
  .row {
    display: flex;
    align-items: flex-start;
    padding: 5px 10px;
    border-bottom: 1px solid #1c1c21;
    gap: 6px;
  }
  .row:last-child {
    border-bottom: none;
  }
  .row-label {
    color: #71717a;
    width: 130px;
    flex-shrink: 0;
    padding-top: 2px;
  }
  .row-value {
    flex: 1;
    color: #f4f4f5;
    word-break: break-all;
  }
  .row-raw {
    margin-top: 3px;
    color: #6b7280;
    font-size: 10px;
    background: #111118;
    padding: 4px 6px;
    border-radius: 3px;
    white-space: pre-wrap;
    max-height: 120px;
    overflow-y: auto;
  }
  .row-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
  }
  .badge {
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    color: white;
  }
  .ts {
    color: #52525b;
    font-size: 10px;
  }
  .header {
    background: #111118;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid #27272a;
    flex-wrap: wrap;
  }
  .log-row {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 3px 10px;
    border-bottom: 1px solid #111118;
    cursor: pointer;
  }
  .log-row:hover {
    background: #18181b;
  }
  .log-ts {
    color: #52525b;
    width: 72px;
    flex-shrink: 0;
  }
  .log-dir {
    width: 32px;
    flex-shrink: 0;
    font-weight: 700;
    font-size: 10px;
  }
  .log-src {
    width: 60px;
    flex-shrink: 0;
  }
  .log-label {
    flex: 1;
    color: #d4d4d8;
  }
  .log-bytes {
    color: #4b5563;
    width: 52px;
    text-align: right;
    flex-shrink: 0;
    font-size: 10px;
  }
  .tooltip {
    position: relative;
  }
  .tooltip:hover::after {
    content: attr(data-tip);
    position: absolute;
    bottom: 110%;
    left: 0;
    background: #1c1c21;
    border: 1px solid #3f3f46;
    color: #e5e7eb;
    padding: 4px 8px;
    border-radius: 4px;
    white-space: nowrap;
    z-index: 100;
    font-size: 11px;
    pointer-events: none;
  }
  input.dev-input {
    background: #18181b;
    border: 1px solid #3f3f46;
    color: #e5e7eb;
    padding: 2px 6px;
    border-radius: 3px;
    font-family: inherit;
    font-size: 11px;
  }
  .sub-tag {
    display: inline-block;
    padding: 1px 6px;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 3px;
    margin: 1px;
    font-size: 10px;
    color: #93c5fd;
  }
</style>
