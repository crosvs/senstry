<script lang="ts">
  import { identity } from '$lib/store/identity';
  import {
    requestCoverageMap, requestChannelCoverage,
    requestSegment, requestSegmentById,
    requestSegmentsAfter, requestSegmentsBefore,
    requestSegmentsInRange,
  } from '$lib/webrtc/viewer-peer';
  import { viewerConnection } from '$lib/store/viewer-connection';
  import { getSegmentById, getSegmentsInRange, getSegmentsAfter, getSegmentsBefore, saveSegment, getCoverageMap, getCoverageByChannel, getDistinctChannels } from '$lib/db/segments';
  import { getFootageRef } from '$lib/db/footage';
  import { dbg } from '$lib/store/debug';
  import { untrack } from 'svelte';
  import DevSection from './DevSection.svelte';
  import LogPanel from './LogPanel.svelte';
  import { onDestroy } from 'svelte';

  interface Props {
    selectedMonitorPubkey?: string | null;
    fetchedCountByMonitor?: Record<string, number>;
    onRegisterClear?: (fn: (pubkey: string) => void) => void;
  }
  let {
    selectedMonitorPubkey = null,
    fetchedCountByMonitor = $bindable<Record<string, number>>({}),
    onRegisterClear,
  }: Props = $props();

  // ── Shared utilities ──────────────────────────────────────────────────────
  function fmtTs(unix: number) { return new Date(unix * 1000).toLocaleTimeString(); }
  function fmtDur(s: number) {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), sec = s % 60;
    return sec ? `${m}m ${sec}s` : `${m}m`;
  }

  // Reads an OPFS-backed blob fully into memory so it survives IDB/OPFS deletion.
  // mimeType must be passed explicitly: OPFS files have no extension so File.type is always "".
  async function materializeBlob(blob: Blob, mimeType: string): Promise<Blob> {
    const buf = await blob.arrayBuffer();
    return new Blob([buf], { type: mimeType });
  }

  // ── Time Range ────────────────────────────────────────────────────────────
  let fetchRangeDate  = $state('');
  let fetchRangeTs    = $state('');
  let playerRangeDate = $state('');
  let playerRangeTs   = $state('');

  function _dateToTsRange(date: string): string {
    const d = new Date(date + 'T00:00:00');
    const from = Math.floor(d.getTime() / 1000);
    const e = new Date(date + 'T23:59:59');
    const to = Math.floor(e.getTime() / 1000);
    return `${from}-${to}`;
  }
  function applyFetchDate()  { if (fetchRangeDate)  fetchRangeTs  = _dateToTsRange(fetchRangeDate);  }
  function applyPlayerDate() { if (playerRangeDate) playerRangeTs = _dateToTsRange(playerRangeDate); }

  function parseRangeInput(input: string): [number, number] | null {
    const t = input.trim();
    const dash = t.lastIndexOf('-');
    if (dash > 0) {
      const f = parseInt(t.slice(0, dash));
      const e = parseInt(t.slice(dash + 1));
      if (!isNaN(f) && !isNaN(e)) return [f, e];
    }
    const ts = parseInt(t);
    if (!isNaN(ts)) return [ts, ts];
    return null;
  }

  // ── General Player ────────────────────────────────────────────────────────
  interface PlayerSeg {
    key: string;
    mimeType: string;
    startTime: number;
    endTime: number;
    blob: Blob;
    url: string;
    channelId?: string;
  }

  let channelPriority = $state<string[]>([]);

  // Per-channel coverage map — populated by coverage fetch (local IDB or RTC).
  // Keys are channel names; values are merged [startTime, endTime] intervals.
  let coverageByChannel = $state<Record<string, [number, number][]>>({});

  // Channel IDs discovered from local IDB before any coverage fetch.
  let localChannelIds = $state<string[]>([]);

  // '' = all channels; non-empty = filter fetch/IDB queries to this channel
  let fetchChannelFilter = $state('');
  // '' = all channels/devices; non-empty = restrict player to that value only
  let playerChannelFilter = $state('');
  let playerDeviceFilter  = $state('');

  let playerSegs = $state<PlayerSeg[]>([]);
  let playerStatus = $state('');
  let playerRangeFrom = $state(0);
  let playerRangeTo = $state(0);
  let playerPosition = $state(0);   // current playback time in unix seconds
  let playerPlaying = $state(false);
  let playerStartedAt = 0;          // Date.now() snapshot when timer was (re)started
  let playerPosAtStart = 0;         // playerPosition value at that moment

  let playerVideoEl = $state<HTMLVideoElement | undefined>();
  let playerAudioEl = $state<HTMLAudioElement | undefined>();
  let playerImgEl   = $state<HTMLImageElement | undefined>();

  let playerVolume = $state(1);

  // Pre-split playerSegs by type and channel once per segment-list change.
  // All per-channel arrays and allVideo/allAudio/photos are sorted by startTime
  // (playerSegs itself is always sorted ascending).
  // videoByEnd is sorted by endTime for the "last ended" lookup.
  const _playerIdx = $derived((() => {
    const videoByChannel = new Map<string, PlayerSeg[]>();
    const audioByChannel = new Map<string, PlayerSeg[]>();
    const photos: PlayerSeg[] = [];
    const allVideo: PlayerSeg[] = [];
    const allAudio: PlayerSeg[] = [];
    for (const s of playerSegs) {
      const ch = s.channelId ?? '';
      if (s.mimeType.startsWith('video/')) {
        if (!videoByChannel.has(ch)) videoByChannel.set(ch, []);
        videoByChannel.get(ch)!.push(s);
        allVideo.push(s);
      } else if (s.mimeType.startsWith('audio/')) {
        if (!audioByChannel.has(ch)) audioByChannel.set(ch, []);
        audioByChannel.get(ch)!.push(s);
        allAudio.push(s);
      } else {
        photos.push(s);
      }
    }
    const videoByEnd = [...allVideo].sort((a, b) => a.endTime - b.endTime);
    return { videoByChannel, audioByChannel, photos, allVideo, allAudio, videoByEnd };
  })());

  // Binary search: segment covering pos (startTime ≤ pos < endTime). segs sorted by startTime.
  function _segAtPos(segs: PlayerSeg[], pos: number): PlayerSeg | null {
    let lo = 0, hi = segs.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].startTime <= pos) lo = mid + 1; else hi = mid - 1; }
    const s = segs[hi];
    return s !== undefined && s.endTime > pos ? s : null;
  }
  // Binary search: last segment with startTime ≤ pos. segs sorted by startTime.
  function _lastAtOrBefore(segs: PlayerSeg[], pos: number): PlayerSeg | null {
    let lo = 0, hi = segs.length - 1, res = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].startTime <= pos) { res = mid; lo = mid + 1; } else hi = mid - 1; }
    return res >= 0 ? segs[res] : null;
  }
  // Binary search: last segment with endTime ≤ pos. segs sorted by endTime.
  function _lastEndedBefore(segs: PlayerSeg[], pos: number): PlayerSeg | null {
    let lo = 0, hi = segs.length - 1, res = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].endTime <= pos) { res = mid; lo = mid + 1; } else hi = mid - 1; }
    return res >= 0 ? segs[res] : null;
  }
  // Binary search: first segment with startTime > pos. segs sorted by startTime.
  function _firstAfter(segs: PlayerSeg[], pos: number): PlayerSeg | null {
    let lo = 0, hi = segs.length - 1, res = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].startTime > pos) { res = mid; hi = mid - 1; } else lo = mid + 1; }
    return res >= 0 ? segs[res] : null;
  }
  // Binary search: first segment with startTime ≥ pos. segs sorted by startTime.
  function _firstAtOrAfter(segs: PlayerSeg[], pos: number): PlayerSeg | null {
    let lo = 0, hi = segs.length - 1, res = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].startTime >= pos) { res = mid; hi = mid - 1; } else lo = mid + 1; }
    return res >= 0 ? segs[res] : null;
  }

  // Video segment covering the current position — prefer highest-priority channel.
  // O(log n) per tick via pre-indexed channel arrays.
  const playerCurVideo = $derived((() => {
    const { videoByChannel, allVideo } = _playerIdx;
    for (const chId of channelPriority) {
      const segs = videoByChannel.get(chId);
      if (segs) { const s = _segAtPos(segs, playerPosition); if (s) return s; }
    }
    return _segAtPos(allVideo, playerPosition);
  })());
  // Audio segment covering the current position — prefer highest-priority channel.
  const playerCurAudio = $derived((() => {
    const { audioByChannel, allAudio } = _playerIdx;
    for (const chId of channelPriority) {
      const segs = audioByChannel.get(chId);
      if (segs) { const s = _segAtPos(segs, playerPosition); if (s) return s; }
    }
    return _segAtPos(allAudio, playerPosition);
  })());
  // Most recently ended video segment (position has moved past its endTime).
  const playerLastEndedVideo = $derived(_lastEndedBefore(_playerIdx.videoByEnd, playerPosition));
  // Photo to display: most recent photo at/before position.
  // A photo only supersedes the last video frame when its startTime is >= that video's endTime.
  // Video always takes priority when active.
  const playerCurPhoto = $derived((() => {
    if (playerCurVideo) return null;
    const { photos, allVideo } = _playerIdx;
    const photo = _lastAtOrBefore(photos, playerPosition);
    if (!photo) return null;
    // Don't show photo if it predates the last ended video — hold the last frame instead
    if (playerLastEndedVideo && photo.startTime < playerLastEndedVideo.endTime) return null;
    const nextPhotoAt = _firstAfter(photos, photo.startTime)?.startTime ?? Infinity;
    const nextVideoAt = _firstAtOrAfter(allVideo, playerPosition)?.startTime ?? Infinity;
    return playerPosition < Math.min(nextPhotoAt, nextVideoAt) ? photo : null;
  })());
  // Hold last video frame when no active video and no qualifying photo has arrived yet
  const playerShowLastFrame = $derived(
    !playerCurVideo && playerLastEndedVideo !== null && playerCurPhoto === null
  );

  let playerTimer: ReturnType<typeof setInterval> | null = null;

  function _playerTick() {
    const pos = playerPosAtStart + (Date.now() - playerStartedAt) / 1000;
    if (pos >= playerRangeTo) {
      playerPosition = playerRangeTo;
      _stopTimer();
      playerPlaying = false;
      playerVideoEl?.pause();
      playerAudioEl?.pause();
    } else {
      playerPosition = pos;
    }
  }

  function _stopTimer() {
    if (playerTimer) { clearInterval(playerTimer); playerTimer = null; }
  }

  function playerPlay() {
    if (playerPlaying || !playerSegs.length) return;
    if (playerPosition >= playerRangeTo) playerPosition = playerRangeFrom;
    playerStartedAt = Date.now();
    playerPosAtStart = playerPosition;
    playerPlaying = true;
    playerTimer = setInterval(_playerTick, 100);
  }

  function playerPause() {
    if (!playerPlaying) return;
    _stopTimer();
    playerPlaying = false;
    playerVideoEl?.pause();
    playerAudioEl?.pause();
  }

  function playerStop() {
    playerPause();
    playerPosition = playerRangeFrom;
  }

  function playerSeekTo(pos: number) {
    const wasPlaying = playerPlaying;
    if (wasPlaying) { _stopTimer(); playerPlaying = false; }
    playerPosition = Math.max(playerRangeFrom, Math.min(playerRangeTo, pos));
    // Seek media elements within the current segment
    if (playerVideoEl && playerCurVideo) {
      playerVideoEl.currentTime = Math.max(0, playerPosition - playerCurVideo.startTime);
    }
    if (playerAudioEl && playerCurAudio) {
      playerAudioEl.currentTime = Math.max(0, playerPosition - playerCurAudio.startTime);
    }
    if (wasPlaying) {
      playerStartedAt = Date.now();
      playerPosAtStart = playerPosition;
      playerPlaying = true;
      playerTimer = setInterval(_playerTick, 100);
    }
  }

  // Load new video segment when playerCurVideo changes; play/pause when playerPlaying changes.
  // Uses dataset.segKey to detect segment changes without tracking playerPosition every tick.
  $effect(() => {
    const seg = playerCurVideo;
    const playing = playerPlaying;
    if (!playerVideoEl) return;
    if (!seg) { playerVideoEl.pause(); return; }
    if (playerVideoEl.dataset.segKey !== seg.key) {
      playerVideoEl.dataset.segKey = seg.key;
      playerVideoEl.src = seg.url;
      playerVideoEl.currentTime = Math.max(0, untrack(() => playerPosition) - seg.startTime);
    }
    if (playing) playerVideoEl.play().catch(() => {});
    else playerVideoEl.pause();
  });

  $effect(() => {
    const seg = playerCurAudio;
    const playing = playerPlaying;
    if (!playerAudioEl) return;
    if (!seg) { playerAudioEl.pause(); return; }
    if (playerAudioEl.dataset.segKey !== seg.key) {
      playerAudioEl.dataset.segKey = seg.key;
      playerAudioEl.src = seg.url;
      playerAudioEl.currentTime = Math.max(0, untrack(() => playerPosition) - seg.startTime);
    }
    if (playing) playerAudioEl.play().catch(() => {});
    else playerAudioEl.pause();
  });

  $effect(() => {
    const photo = playerCurPhoto;
    if (!playerImgEl || !photo) return;
    if (playerImgEl.dataset.segKey !== photo.key) {
      playerImgEl.dataset.segKey = photo.key;
      playerImgEl.src = photo.url;
    }
  });

  $effect(() => {
    if (playerVideoEl) playerVideoEl.volume = playerVolume;
    if (playerAudioEl) playerAudioEl.volume = playerVolume;
  });

  function loadPlayerSegments() {
    const parsed = parseRangeInput(playerRangeTs);
    if (!parsed) { playerStatus = '✗ Set a time range first'; return; }
    const [from, to] = parsed;

    for (const s of playerSegs) URL.revokeObjectURL(s.url);
    playerPause();
    playerSegs = [];
    playerPosition = from;
    playerRangeFrom = from;
    playerRangeTo = to;
    if (playerVideoEl) { playerVideoEl.removeAttribute('data-seg-key'); playerVideoEl.removeAttribute('src'); }
    if (playerAudioEl) { playerAudioEl.removeAttribute('data-seg-key'); playerAudioEl.removeAttribute('src'); }
    if (playerImgEl)   { playerImgEl.removeAttribute('data-seg-key'); playerImgEl.removeAttribute('src'); }

    const inRange = fetchedSegs.filter(s =>
      s.startTime < to && s.endTime > from &&
      (!playerDeviceFilter  || s.originMonitor === playerDeviceFilter) &&
      (!playerChannelFilter || s.channelId === playerChannelFilter) &&
      [...playerTypeFilter].some(p => s.mimeType.startsWith(p))
    );
    if (inRange.length === 0) {
      playerStatus = fetchedSegs.length === 0
        ? '✗ Use Fetch Content below to load segments first'
        : '✗ No fetched segments match the selected range, types, and channel';
      return;
    }

    const loaded: PlayerSeg[] = inRange.map(s => ({
      key: s.key,
      mimeType: s.mimeType,
      startTime: s.startTime,
      endTime: s.endTime,
      blob: s.blob,
      url: URL.createObjectURL(s.blob),
      channelId: s.channelId,
    }));
    loaded.sort((a, b) => a.startTime - b.startTime);
    playerSegs = loaded;
    const vCount = loaded.filter(s => s.mimeType.startsWith('video/')).length;
    const aCount = loaded.filter(s => s.mimeType.startsWith('audio/')).length;
    const pCount = loaded.filter(s => s.mimeType.startsWith('image/')).length;
    playerStatus = `✓ ${loaded.length} segment${loaded.length !== 1 ? 's' : ''} — ${vCount}v ${aCount}a ${pCount}p`;
  }

  const vc = $derived($viewerConnection);
  const isOnline = $derived(vc.status === 'online');

  // ── Segment Viewer (in fetched-segments area) ────────────────────────────
  interface FetchedSeg {
    key: string;
    source: 'rtc' | 'idb';
    originMonitor: string;
    mimeType: string;
    startTime: number;
    endTime: number;
    blob: Blob;
    segmentId?: string;
    backupOf?: string | null;
    channelId?: string;
  }

  let fetchedSegs = $state<FetchedSeg[]>([]);

  // Distinct monitors and channels present in the fetched list.
  const fetchedDeviceIds = $derived(
    [...new Set(fetchedSegs.map(s => s.originMonitor).filter(Boolean))]
  );
  const browsedSegsWithIdx = $derived(
    fetchedSegs
      .map((seg, i) => ({ seg, i }))
      .filter(({ seg }) => !selectedMonitorPubkey || seg.originMonitor === selectedMonitorPubkey)
  );
  const browsedIdx = $derived(
    browsedSegsWithIdx.findIndex(({ i }) => i === currentIdx)
  );
  const fetchedChannelIds = $derived(
    [...new Set(fetchedSegs.map(s => s.channelId).filter((id): id is string => !!id))]
  );

  // Distinct channels present in the player's loaded segments.
  const playerChannelIds = $derived(
    [...new Set(playerSegs.map(s => s.channelId).filter((id): id is string => !!id))]
  );

  // Options for the player channel filter: channels present in fetched or currently loaded segments.
  const playerFilterOptions = $derived(fetchedChannelIds.length ? fetchedChannelIds : playerChannelIds);

  // All known channel IDs for the fetch channel filter: coverage map + IDB discovery + fetched segments.
  // Filtered to channels that overlap the current fetch time range when coverage data is available.
  const knownChannelIds = $derived((() => {
    const all = [...new Set([...Object.keys(coverageByChannel), ...localChannelIds, ...fetchedChannelIds])];
    const range = parseRangeInput(fetchRangeTs);
    if (!range || Object.keys(coverageByChannel).length === 0) return all.sort();
    const [from, to] = range;
    return all.filter(ch => {
      const ranges = coverageByChannel[ch];
      if (!ranges) return true; // discovered but no coverage data — include it
      return ranges.some(([s, e]) => e >= from && s <= to);
    }).sort();
  })());

  // Reset channel state on device switch; populate basic channel list from local IDB.
  $effect(() => {
    const effectivePubkey = selectedMonitorPubkey ?? $identity?.pubkey;
    localChannelIds = [];
    coverageByChannel = {};
    fetchChannelFilter = '';
    playerChannelFilter = '';
    if (effectivePubkey) {
      getDistinctChannels(effectivePubkey).then(ids => { localChannelIds = ids; });
    }
  });

  // Auto-clear filters when the selected value leaves the available set.
  $effect(() => {
    if (fetchChannelFilter && !knownChannelIds.includes(fetchChannelFilter)) fetchChannelFilter = '';
    if (playerChannelFilter && !fetchedChannelIds.includes(playerChannelFilter)) playerChannelFilter = '';
    if (playerDeviceFilter  && !fetchedDeviceIds.includes(playerDeviceFilter))  playerDeviceFilter  = '';
  });

  // Sync channelPriority when the player's loaded channels change (preserve existing order).
  $effect(() => {
    const chIds = playerChannelIds;
    const current = untrack(() => channelPriority);
    channelPriority = [
      ...current.filter(id => chIds.includes(id)),
      ...chIds.filter(id => !current.includes(id)),
    ];
  });

  function moveChannelUp(i: number) {
    if (i <= 0) return;
    const copy = [...channelPriority];
    [copy[i - 1], copy[i]] = [copy[i], copy[i - 1]];
    channelPriority = copy;
  }
  function moveChannelDown(i: number) {
    if (i >= channelPriority.length - 1) return;
    const copy = [...channelPriority];
    [copy[i], copy[i + 1]] = [copy[i + 1], copy[i]];
    channelPriority = copy;
  }

  let currentIdx = $state(-1);
  let currentViewerUrl = $state<string | null>(null);
  let autoPlayNext = $state(false);
  let autoPlayCountdown = $state(0);
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  let viewerVideoEl = $state<HTMLVideoElement | undefined>();
  let viewerAudioEl = $state<HTMLAudioElement | undefined>();
  let viewerImgEl = $state<HTMLImageElement | undefined>();
  let viewerError = $state('');

  const currentSeg = $derived(currentIdx >= 0 ? fetchedSegs[currentIdx] : null);

  $effect(() => {
    if (!currentSeg) { currentViewerUrl = null; viewerError = ''; return; }
    viewerError = '';
    const url = URL.createObjectURL(currentSeg.blob);
    currentViewerUrl = url;
    return () => { URL.revokeObjectURL(url); currentViewerUrl = null; };
  });

  $effect(() => {
    if (viewerVideoEl && currentViewerUrl && currentSeg?.mimeType.startsWith('video/')) {
      viewerVideoEl.src = currentViewerUrl;
      viewerVideoEl.load();
      viewerVideoEl.play().catch(() => {});
    }
  });

  $effect(() => {
    if (viewerAudioEl && currentViewerUrl && currentSeg?.mimeType.startsWith('audio/')) {
      viewerAudioEl.src = currentViewerUrl;
      viewerAudioEl.load();
      viewerAudioEl.play().catch(() => {});
    }
  });

  $effect(() => {
    if (viewerImgEl && currentViewerUrl && currentSeg?.mimeType.startsWith('image/')) {
      viewerImgEl.src = currentViewerUrl;
      if (autoPlayNext) startPhotoCountdown();
    }
  });

  function startPhotoCountdown() {
    clearAutoPlayTimer();
    autoPlayCountdown = 3;
    countdownTimer = setInterval(() => {
      autoPlayCountdown--;
      if (autoPlayCountdown <= 0) { clearAutoPlayTimer(); advanceToNext(); }
    }, 1000);
  }

  function clearAutoPlayTimer() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    autoPlayCountdown = 0;
  }

  function handleVideoEnded() {
    if (!autoPlayNext) return;
    advanceToNext();
  }

  function advanceToNext() {
    if (currentIdx + 1 < fetchedSegs.length) showSeg(currentIdx + 1);
    else fetchAdjacent('after');
  }

  function showSeg(idx: number) {
    if (idx < 0 || idx >= fetchedSegs.length) return;
    clearAutoPlayTimer();
    currentIdx = idx;
  }

  async function prevSeg() {
    const pos = browsedIdx;
    if (pos > 0) { showSeg(browsedSegsWithIdx[pos - 1].i); setNavStatus(''); }
    else await fetchAdjacent('before');
  }

  async function nextSeg() {
    const pos = browsedIdx;
    if (pos >= 0 && pos + 1 < browsedSegsWithIdx.length) { showSeg(browsedSegsWithIdx[pos + 1].i); setNavStatus(''); }
    else await fetchAdjacent('after');
  }

  function pushSeg(seg: FetchedSeg) {
    if (fetchedSegs.some(s => s.key === seg.key)) return;
    const currentKey = currentIdx >= 0 ? fetchedSegs[currentIdx]?.key : null;
    const sorted = [...fetchedSegs, seg].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    fetchedSegs = sorted;
    if (currentKey != null) currentIdx = sorted.findIndex(s => s.key === currentKey);
  }

  function removeSeg(i: number) {
    const key = fetchedSegs[i]?.key;
    fetchedSegs = fetchedSegs.filter((_, j) => j !== i);
    if (key) { savedKeys.delete(key); savedKeys = new Set(savedKeys); }
    if (currentIdx >= fetchedSegs.length) currentIdx = fetchedSegs.length - 1;
    else if (currentIdx > i) currentIdx--;
  }

  // ── Adjacent boundary navigation ─────────────────────────────────────────
  let navStatus = $state('');
  let navLoading = $state(false);
  let navStatusTimer: ReturnType<typeof setTimeout> | null = null;

  function setNavStatus(msg: string, autoClearMs = 0) {
    if (navStatusTimer) { clearTimeout(navStatusTimer); navStatusTimer = null; }
    navStatus = msg;
    if (autoClearMs > 0) {
      navStatusTimer = setTimeout(() => { navStatus = ''; navStatusTimer = null; }, autoClearMs);
    }
  }

  // Used by prevSeg/nextSeg boundary navigation — small, snappy count.
  const ADJACENT_COUNT = 3;

  // ── Fetch count + source toggles ─────────────────────────────────────────
  // fetchCount = 0 means "as many as possible" (50 for RTC, unlimited for local)
  let fetchCount = $state(10);
  let fetchSourceLocal = $state(true);
  let fetchSourceRtc   = $state(true);

  function toggleFetchSource(src: 'local' | 'rtc') {
    if (src === 'local' && !fetchSourceRtc) return;
    if (src === 'rtc'   && !fetchSourceLocal) return;
    if (src === 'local') fetchSourceLocal = !fetchSourceLocal;
    else                 fetchSourceRtc   = !fetchSourceRtc;
  }

  async function fetchInRange(order: 'asc' | 'desc') {
    const effectivePubkey = selectedMonitorPubkey ?? $identity?.pubkey;
    const range = rangeOrError(); if (!range) return;
    const { from, to } = range;

    const rtcLimit = fetchCount === 0 ? 50 : fetchCount;
    fetchLoading = true;
    const existing = new Set(fetchedSegs.map(s => s.key));
    let added = 0;

    try {
      if (fetchSourceLocal && effectivePubkey) {
        fetchStatus = 'Querying local IDB…';
        const metas = await getSegmentsInRange(from, to, effectivePubkey, fetchChannelFilter || undefined);
        const sorted = metas
          .filter(m => [...fetchTypeFilter].some(p => m.mimeType.startsWith(p)))
          .sort((a, b) => order === 'desc' ? b.startTime - a.startTime : a.startTime - b.startTime);

        for (const meta of sorted) {
          if (fetchCount > 0 && added >= fetchCount) break;
          const key = `idb-${effectivePubkey}-${meta.segmentId}`;
          if (existing.has(key)) continue;
          const withBlob = await getSegmentById(meta.segmentId);
          if (!withBlob) continue;
          existing.add(key);
          const blob = await materializeBlob(withBlob.blob, withBlob.mimeType);
          pushSeg({ key, source: 'idb', originMonitor: effectivePubkey, mimeType: withBlob.mimeType, startTime: withBlob.startTime, endTime: withBlob.endTime, blob, segmentId: withBlob.segmentId, backupOf: withBlob.backupOf, channelId: withBlob.channelId });
          added++;
        }
      }

      if (fetchSourceRtc && $identity && selectedMonitorPubkey) {
        if (!isOnline) {
          if (added === 0) fetchStatus = '✗ WebRTC offline — connect first or use Local IDB only';
          else fetchStatus = `✓ ${added} local segment${added !== 1 ? 's' : ''} (WebRTC offline)`;
          fetchLoading = false;
          if (currentIdx < 0 && fetchedSegs.length > 0) showSeg(0);
          return;
        }
        const knownIds = fetchedSegs
          .filter(s => s.segmentId && s.startTime < to && s.endTime > from)
          .map(s => s.segmentId!);

        fetchStatus = 'Requesting from monitor…';
        try {
          const remoteMetas = await requestSegmentsInRange(
            from, to, rtcLimit, order, knownIds,
            $identity.privkey, $identity.pubkey, selectedMonitorPubkey,
            undefined, fetchChannelFilter || undefined
          );
          const filtered = remoteMetas.filter(m => [...fetchTypeFilter].some(p => m.mimeType.startsWith(p)));
          for (const meta of filtered) {
            if (fetchCount > 0 && added >= fetchCount) break;
            const key = `rtc-${selectedMonitorPubkey}-${meta.segmentId}`;
            if (existing.has(key)) continue;
            fetchStatus = `Fetching ${fmtTs(meta.startTime)}…`;
            try {
              const res = await requestSegmentById(meta.segmentId, $identity.privkey, $identity.pubkey, selectedMonitorPubkey);
              existing.add(key);
              pushSeg({ key, source: 'rtc', originMonitor: selectedMonitorPubkey, mimeType: res.mimeType, startTime: res.startTime, endTime: res.endTime, blob: res.blob, segmentId: res.segmentId || undefined, channelId: res.channelId });
              added++;
            } catch { continue; }
          }
        } catch (e) {
          if (!fetchSourceLocal) {
            fetchStatus = `✗ ${e instanceof Error ? e.message : 'Could not reach monitor'}`;
            fetchLoading = false;
            return;
          }
        }
      }

      fetchStatus = added === 0 ? '✗ No new segments' : `✓ ${added} segment${added !== 1 ? 's' : ''}`;
      if (currentIdx < 0 && fetchedSegs.length > 0) showSeg(0);
    } catch (e) {
      fetchStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { fetchLoading = false; }
  }

  // jumpToFirst: jump to first newly found segment (explicit fetch) vs segment adjacent to current (nav).
  // count: how many to fetch. refTimeOverride: explicit anchor; undefined = use list boundary.
  // useLocal/useRtc: which sources to query (defaults true for boundary navigation).
  async function fetchAdjacent(dir: 'after' | 'before', jumpToFirst = false, count = ADJACENT_COUNT, refTimeOverride?: number, useLocal = true, useRtc = true) {
    if (navLoading) return;
    if (refTimeOverride === undefined && fetchedSegs.length === 0) return;
    navLoading = true;

    const prevLen = fetchedSegs.length;
    const refTime = refTimeOverride ?? (dir === 'after'
      ? fetchedSegs[prevLen - 1].endTime
      : fetchedSegs[0].startTime);

    setNavStatus(dir === 'after' ? 'Looking for later footage…' : 'Looking for earlier footage…');

    let added = 0;
    const idxBefore = currentIdx;

    try {
      const effectivePubkey = selectedMonitorPubkey ?? $identity?.pubkey;

      if (useLocal && effectivePubkey) {
        const metas = dir === 'after'
          ? await getSegmentsAfter(refTime, count, effectivePubkey, undefined, fetchChannelFilter || undefined)
          : await getSegmentsBefore(refTime, count, effectivePubkey, undefined, fetchChannelFilter || undefined);

        const filtered = metas.filter(m => [...fetchTypeFilter].some(p => m.mimeType.startsWith(p)));
        for (const meta of filtered) {
          const key = `idb-${effectivePubkey}-${meta.segmentId}`;
          if (fetchedSegs.some(s => s.key === key)) continue;
          const withBlob = await getSegmentById(meta.segmentId);
          if (!withBlob) continue;
          const blob = await materializeBlob(withBlob.blob, withBlob.mimeType);
          pushSeg({ key, source: 'idb', originMonitor: effectivePubkey, mimeType: withBlob.mimeType, startTime: withBlob.startTime, endTime: withBlob.endTime, blob, segmentId: withBlob.segmentId, backupOf: withBlob.backupOf, channelId: withBlob.channelId });
          added++;
        }
      }

      if (added === 0 && useRtc && $identity && selectedMonitorPubkey && isOnline) {
        setNavStatus(dir === 'after' ? 'Requesting from monitor…' : 'Requesting earlier from monitor…');
        try {
          const remoteMetas = dir === 'after'
            ? await requestSegmentsAfter(refTime, count, $identity.privkey, $identity.pubkey, selectedMonitorPubkey)
            : await requestSegmentsBefore(refTime, count, $identity.privkey, $identity.pubkey, selectedMonitorPubkey);

          const filtered = remoteMetas.filter(m => [...fetchTypeFilter].some(p => m.mimeType.startsWith(p)));
          for (const meta of filtered) {
            const key = `rtc-${selectedMonitorPubkey}-${meta.segmentId}`;
            if (fetchedSegs.some(s => s.key === key || (s.segmentId === meta.segmentId && s.originMonitor === selectedMonitorPubkey))) continue;
            try {
              const res = await requestSegmentById(meta.segmentId, $identity.privkey, $identity.pubkey, selectedMonitorPubkey);
              pushSeg({ key, source: 'rtc', originMonitor: selectedMonitorPubkey, mimeType: res.mimeType, startTime: res.startTime, endTime: res.endTime, blob: res.blob, segmentId: res.segmentId || undefined, channelId: res.channelId });
              added++;
            } catch { continue; }
          }
        } catch { /* monitor offline */ }
      }

      if (added > 0) {
        if (jumpToFirst) {
          // 'after': new segs sort to end → first is at prevLen. 'before': sort to front → first is at 0.
          showSeg(dir === 'after' ? prevLen : 0);
        } else {
          if (dir === 'after') showSeg(idxBefore + 1);
          else showSeg(currentIdx - 1);
        }
        setNavStatus('');
      } else {
        setNavStatus(
          dir === 'after' ? 'No more footage — end of available recordings' : 'No earlier footage — start of available recordings',
          7000
        );
      }
    } catch {
      setNavStatus(`Could not load ${dir === 'after' ? 'later' : 'earlier'} footage`, 4000);
    } finally {
      navLoading = false;
    }
  }

  async function fetchExplicitBefore() {
    const parsed = parseRangeInput(fetchRangeTs);
    if (!parsed) { setNavStatus('Set a time range first', 5000); return; }
    const prevCount = fetchedSegs.length;
    const count = fetchCount === 0 ? 50 : fetchCount;
    await fetchAdjacent('before', true, count, parsed[0], fetchSourceLocal, fetchSourceRtc);
    if (fetchedSegs.length > prevCount && fetchedSegs.length > 0) {
      const newStart = fetchedSegs[0].startTime;
      if (newStart < parsed[0]) fetchRangeTs = `${newStart}-${parsed[1]}`;
    }
  }

  async function fetchExplicitAfter() {
    const parsed = parseRangeInput(fetchRangeTs);
    if (!parsed) { setNavStatus('Set a time range first', 5000); return; }
    const prevCount = fetchedSegs.length;
    const count = fetchCount === 0 ? 50 : fetchCount;
    await fetchAdjacent('after', true, count, parsed[1], fetchSourceLocal, fetchSourceRtc);
    if (fetchedSegs.length > prevCount && fetchedSegs.length > 0) {
      const newEnd = fetchedSegs[fetchedSegs.length - 1].endTime;
      if (newEnd > parsed[1]) fetchRangeTs = `${parsed[0]}-${newEnd}`;
    }
  }

  // ── Coverage ─────────────────────────────────────────────────────────────
  let remoteCoverage = $state<[number, number][] | null>(null);
  let remoteCoverageStatus = $state('');
  let remoteCoverageLoading = $state(false);

  let localCoverage = $state<[number, number][] | null>(null);
  let localCoverageStatus = $state('');
  let localCoverageLoading = $state(false);

  async function requestRemoteCoverage() {
    if (!$identity || !selectedMonitorPubkey) { remoteCoverageStatus = 'Select a monitor device first'; return; }
    remoteCoverageLoading = true; remoteCoverageStatus = 'Requesting…'; remoteCoverage = null;
    const privkey = $identity.privkey;
    const viewerPubkey = $identity.pubkey;
    const monitorPubkey = selectedMonitorPubkey;
    try {
      const [coverageResult, channelCoverageResult] = await Promise.allSettled([
        requestCoverageMap(privkey, viewerPubkey, monitorPubkey),
        requestChannelCoverage(privkey, viewerPubkey, monitorPubkey),
      ]);
      if (coverageResult.status === 'fulfilled') {
        remoteCoverage = coverageResult.value;
        remoteCoverageStatus = coverageResult.value.length
          ? `✓ ${coverageResult.value.length} range${coverageResult.value.length !== 1 ? 's' : ''}`
          : '✓ No footage';
      } else {
        remoteCoverageStatus = `✗ ${coverageResult.reason instanceof Error ? coverageResult.reason.message : 'Failed'}`;
      }
      if (channelCoverageResult.status === 'fulfilled') {
        coverageByChannel = { ...coverageByChannel, ...channelCoverageResult.value };
      }
    } finally { remoteCoverageLoading = false; }
  }

  async function loadLocalCoverage() {
    const effectivePubkey = selectedMonitorPubkey ?? $identity?.pubkey;
    if (!effectivePubkey) { localCoverageStatus = 'No device selected'; return; }
    localCoverageLoading = true; localCoverageStatus = 'Reading IDB…'; localCoverage = null;
    try {
      const [map, byChannel] = await Promise.all([
        getCoverageMap(effectivePubkey, undefined, fetchChannelFilter || undefined),
        getCoverageByChannel(effectivePubkey),
      ]);
      localCoverage = map;
      localCoverageStatus = map.length ? `✓ ${map.length} range${map.length !== 1 ? 's' : ''}` : '✓ Nothing stored';
      coverageByChannel = { ...coverageByChannel, ...byChannel };
    } catch (e) {
      localCoverageStatus = `✗ ${e instanceof Error ? e.message : 'Failed'}`;
    } finally { localCoverageLoading = false; }
  }

  const bothCoverageLoading = $derived(remoteCoverageLoading || localCoverageLoading);

  async function fetchBothCoverage() {
    await Promise.all([requestRemoteCoverage(), loadLocalCoverage()]);
  }

  // ── Type Filters ─────────────────────────────────────────────────────────
  type MimePrefix = 'video/' | 'audio/' | 'image/';
  const TYPE_LABELS: Record<MimePrefix, string> = { 'video/': 'Video', 'audio/': 'Audio', 'image/': 'Photo' };
  const TYPE_STEP: Record<MimePrefix, number> = { 'video/': 10, 'audio/': 10, 'image/': 1 };
  const ALL_MIME_PREFIXES: MimePrefix[] = ['video/', 'audio/', 'image/'];

  let fetchTypeFilter  = $state<Set<MimePrefix>>(new Set(ALL_MIME_PREFIXES));
  let playerTypeFilter = $state<Set<MimePrefix>>(new Set(ALL_MIME_PREFIXES));

  function _toggleType(current: Set<MimePrefix>, t: MimePrefix): Set<MimePrefix> {
    const next = new Set(current);
    if (next.has(t) && next.size > 1) next.delete(t); else next.add(t);
    return next;
  }
  function toggleFetchType(t: MimePrefix)  { fetchTypeFilter  = _toggleType(fetchTypeFilter,  t); }
  function togglePlayerType(t: MimePrefix) { playerTypeFilter = _toggleType(playerTypeFilter, t); }

  // ── Fetch Segments in Range ──────────────────────────────────────────────
  let fetchStatus = $state('');
  let fetchLoading = $state(false);

  function rangeOrError(): { from: number; to: number } | null {
    const parsed = parseRangeInput(fetchRangeTs);
    if (!parsed) { fetchStatus = '✗ Set a valid time range'; return null; }
    const [from, to] = parsed;
    if (from > to) { fetchStatus = '✗ Start must be ≤ end'; return null; }
    return { from, to };
  }

  // ── Fetch by ID ──────────────────────────────────────────────────────────
  let segIdInput = $state('');
  let segIdStatus = $state('');
  let segIdLoading = $state(false);

  async function fetchByIdRtc() {
    if (!$identity || !selectedMonitorPubkey) { segIdStatus = 'Select a monitor device first'; return; }
    const id = segIdInput.trim();
    if (!id) { segIdStatus = '✗ Enter an ID'; return; }
    segIdLoading = true; segIdStatus = 'Fetching…';
    try {
      const res = await requestSegmentById(id, $identity.privkey, $identity.pubkey, selectedMonitorPubkey);
      const key = `rtc-${selectedMonitorPubkey}-${res.segmentId || id}`;
      pushSeg({ key, source: 'rtc', originMonitor: selectedMonitorPubkey, mimeType: res.mimeType, startTime: res.startTime, endTime: res.endTime, blob: res.blob, segmentId: res.segmentId || undefined, channelId: res.channelId });
      showSeg(fetchedSegs.findIndex(s => s.key === key));
      segIdStatus = `✓ ${res.mimeType} [${fmtTs(res.startTime)}–${fmtTs(res.endTime)}]`;
    } catch (e) {
      segIdStatus = `✗ ${e instanceof Error ? e.message : 'Not found'}`;
    } finally { segIdLoading = false; }
  }

  async function fetchByIdIdb() {
    const id = segIdInput.trim();
    if (!id) { segIdStatus = '✗ Enter an ID'; return; }
    segIdLoading = true; segIdStatus = 'Looking up…';
    try {
      let seg = await getSegmentById(id);
      if (!seg) {
        const ref = await getFootageRef(id);
        if (ref) {
          const segs = await getSegmentsInRange(ref.startTime, ref.endTime, ref.originMonitor);
          if (segs.length > 0) seg = (await getSegmentById(segs[0].segmentId)) ?? undefined;
        }
      }
      if (seg) {
        const key = `idb-${seg.originMonitor}-${seg.segmentId}`;
        const blob = await materializeBlob(seg.blob, seg.mimeType);
        pushSeg({ key, source: 'idb', originMonitor: seg.originMonitor, mimeType: seg.mimeType, startTime: seg.startTime, endTime: seg.endTime, blob, segmentId: seg.segmentId, backupOf: seg.backupOf, channelId: seg.channelId });
        showSeg(fetchedSegs.findIndex(s => s.key === key));
        segIdStatus = `✓ Local [${fmtTs(seg.startTime)}–${fmtTs(seg.endTime)}]`;
      } else {
        segIdStatus = '✗ Not found locally';
      }
    } catch (e) {
      segIdStatus = `✗ ${e instanceof Error ? e.message : 'Error'}`;
    } finally { segIdLoading = false; }
  }

  // ── Save / copy / clear ──────────────────────────────────────────────────
  let savedKeys  = $state(new Set<string>());
  let savingKeys = $state(new Set<string>());
  let showRaw = $state(false);

  async function saveSeg(i: number) {
    const seg = fetchedSegs[i];
    if (!seg || seg.source !== 'rtc') return;
    if (savedKeys.has(seg.key) || savingKeys.has(seg.key)) return;
    savingKeys = new Set([...savingKeys, seg.key]);
    try {
      await saveSegment(seg.blob, seg.mimeType, seg.startTime, seg.endTime, seg.originMonitor, seg.channelId ?? 'default-channel', seg.segmentId ?? null);
      savedKeys = new Set([...savedKeys, seg.key]);
      dbg('info', 'idb', `saved remote segment [${fmtTs(seg.startTime)}–${fmtTs(seg.endTime)}] ${seg.mimeType.split('/')[0]} ${(seg.blob.size / 1024).toFixed(0)}KB monitor:${seg.originMonitor.slice(0, 8)}${seg.channelId ? ` ch:${seg.channelId}` : ''}`);
    } catch (e) {
      dbg('warn', 'idb', `save segment failed [${fmtTs(seg.startTime)}–${fmtTs(seg.endTime)}] ${seg.mimeType} monitor:${seg.originMonitor.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      savingKeys = new Set([...savingKeys].filter(k => k !== seg.key));
    }
  }

  async function copyText(s: string) { await navigator.clipboard.writeText(s); }

  function clearSegments() {
    fetchedSegs = []; currentIdx = -1; currentViewerUrl = null;
    clearAutoPlayTimer(); savedKeys = new Set(); savingKeys = new Set();
  }

  function clearFetchedForMonitor(pubkey: string) {
    const toRemove = new Set(fetchedSegs.filter(s => s.originMonitor === pubkey).map(s => s.key));
    if (toRemove.size === 0) return;
    const currentKey = currentIdx >= 0 ? fetchedSegs[currentIdx]?.key : null;
    fetchedSegs = fetchedSegs.filter(s => s.originMonitor !== pubkey);
    savedKeys  = new Set([...savedKeys].filter(k => !toRemove.has(k)));
    savingKeys = new Set([...savingKeys].filter(k => !toRemove.has(k)));
    if (fetchedSegs.length === 0) {
      currentIdx = -1; currentViewerUrl = null; clearAutoPlayTimer();
    } else if (currentKey && toRemove.has(currentKey)) {
      currentIdx = 0;
    } else if (currentKey) {
      currentIdx = fetchedSegs.findIndex(s => s.key === currentKey);
    }
  }

  // Keep fetchedCountByMonitor bindable in sync with the flat list.
  $effect(() => {
    const c: Record<string, number> = {};
    for (const s of fetchedSegs) c[s.originMonitor] = (c[s.originMonitor] ?? 0) + 1;
    fetchedCountByMonitor = c;
  });

  // Register the per-device clear function with the parent once on mount.
  $effect(() => { onRegisterClear?.(clearFetchedForMonitor); });

  onDestroy(() => {
    clearAutoPlayTimer();
    if (navStatusTimer) clearTimeout(navStatusTimer);
    _stopTimer();
    for (const s of playerSegs) URL.revokeObjectURL(s.url);
  });
</script>

<DevSection title="Fetched Segments Player">

  <!-- Channel priority -->
  {#if playerChannelIds.length > 1}
    <div class="priority-row">
      <span class="muted-sep">Channel priority:</span>
      {#each channelPriority as chId, i (chId)}
        <span class="prio-chip" title="Player shows this channel's footage when multiple channels cover the same time">
          <span class="prio-rank">#{i + 1}</span>
          <span class="prio-name">{chId}</span>
          {#if i > 0}<button class="prio-btn" onclick={() => moveChannelUp(i)} title="Higher priority">↑</button>{/if}
          {#if i < channelPriority.length - 1}<button class="prio-btn" onclick={() => moveChannelDown(i)} title="Lower priority">↓</button>{/if}
        </span>
      {/each}
      <span class="muted-sep">· #1 video, #1 audio (fallback to next available)</span>
    </div>
  {/if}

  <!-- Player time range -->
  <div class="range-row" style="margin-bottom:4px;">
    <input type="date" class="date-input" bind:value={playerRangeDate} onchange={applyPlayerDate} />
    <span class="muted-sep">or manually:</span>
    <input class="ts-input" bind:value={playerRangeTs} placeholder="unix or start-end" style="width:200px" />
  </div>

  <!-- Type filter + device filter + channel filter + Load -->
  <div class="row" style="margin-bottom:4px; gap:4px;">
    <span class="muted-sep">Types:</span>
    {#each ALL_MIME_PREFIXES as prefix}
      <button class="type-filter-btn" class:active={playerTypeFilter.has(prefix)} onclick={() => togglePlayerType(prefix)}>
        {TYPE_LABELS[prefix]}
      </button>
    {/each}
    {#if fetchedDeviceIds.length > 1}
      <span class="ctrl-divider">|</span>
      <select class="source-select"
        onchange={(e) => { playerDeviceFilter = (e.target as HTMLSelectElement).value; }}
        title="Filter player to segments from one monitor — shown because multiple devices are loaded">
        <option value="" selected={playerDeviceFilter === ''}>All devices</option>
        {#each fetchedDeviceIds as pubkey (pubkey)}
          <option value={pubkey} selected={pubkey === playerDeviceFilter}>{pubkey.slice(0, 8)}</option>
        {/each}
      </select>
    {/if}
    <span class="ctrl-divider">|</span>
    <select class="source-select"
      onchange={(e) => { playerChannelFilter = (e.target as HTMLSelectElement).value; }}
      disabled={playerFilterOptions.length === 0}
      title={playerFilterOptions.length === 0 ? 'Fetch segments below to discover channels' : 'Filter player to a specific channel — populated from fetched segments'}>
      <option value="" selected={playerChannelFilter === ''}>All channels</option>
      {#each playerFilterOptions as chId (chId)}
        <option value={chId} selected={chId === playerChannelFilter}>{chId}</option>
      {/each}
    </select>
    <span class="ctrl-divider">|</span>
    <button class="act-btn accent-soft" onclick={loadPlayerSegments} title="Load segments from local IDB for the given time range">
      Load
    </button>
    {#if playerStatus}
      <span class="status" class:ok={playerStatus.startsWith('✓')} class:err={playerStatus.startsWith('✗')}>{playerStatus}</span>
    {/if}
  </div>
  <div class="hint-row">Filters from segments fetched below · use the time range to crop the view</div>

  <!-- ── General Player ───────────────────────────────────────────────────── -->
  <div class="player-box">
    <!-- Video always rendered; visibility controlled by style so bind:this is always resolved -->
    <video bind:this={playerVideoEl}
      style:display={playerCurVideo || playerShowLastFrame ? 'block' : 'none'}
      class="player-media" playsinline></video>
    <img bind:this={playerImgEl} alt="Snapshot"
      style:display={!playerCurVideo && !playerShowLastFrame && playerCurPhoto ? 'block' : 'none'}
      class="player-media" />
    {#if !playerCurVideo && !playerShowLastFrame && !playerCurPhoto}
      <div class="player-empty">
        {#if !playerSegs.length}No segments loaded — set a time range above and click Load{:else}No footage at this position{/if}
      </div>
    {/if}
  </div>
  <!-- Audio always rendered (hidden) -->
  <audio bind:this={playerAudioEl} style="display:none"></audio>

  <!-- Scrubber + controls -->
  {#if playerSegs.length > 0}
    <div class="player-scrubber-row">
      <input type="range"
        min={playerRangeFrom} max={playerRangeTo} step={1}
        value={playerPosition}
        oninput={(e) => playerSeekTo(+(e.target as HTMLInputElement).value)}
        class="player-scrubber" />
    </div>
  {/if}

  <div class="row" style="gap:6px">
    <button class="act-btn accent" onclick={playerPlaying ? playerPause : playerPlay}
      disabled={!playerSegs.length}>
      {playerPlaying ? '⏸ Pause' : '▶ Play'}
    </button>
    <button class="act-btn" onclick={playerStop} disabled={!playerSegs.length} title="Stop and return to start">
      ■ Stop
    </button>
    {#if playerSegs.length > 0}
      <span class="player-pos">
        {fmtTs(playerPosition)}
        {#if playerRangeTo > playerRangeFrom}
          · +{fmtDur(Math.round(playerPosition - playerRangeFrom))} / {fmtDur(playerRangeTo - playerRangeFrom)}
        {/if}
        {#if playerCurVideo && playerCurAudio}· video+audio
        {:else if playerCurVideo}· video
        {:else if playerCurAudio}· audio
        {:else if playerShowLastFrame}· last frame
        {:else if playerCurPhoto}· photo
        {/if}
      </span>
    {/if}
    <label class="vol-label" title="Volume">
      🔊
      <input type="range" min={0} max={1} step={0.01} bind:value={playerVolume} class="vol-slider" />
      <span class="vol-pct">{Math.round(playerVolume * 100)}%</span>
    </label>
  </div>

</DevSection>

<DevSection title="Fetch Content">
  <!-- ── Time Range + Coverage ────────────────────────────────────────────── -->
  <div class="subsec-title">Time Range</div>
  <div class="range-row">
    <input type="date" class="date-input" bind:value={fetchRangeDate} onchange={applyFetchDate} />
    <span class="muted-sep">or manually:</span>
    <input class="ts-input" bind:value={fetchRangeTs} placeholder="unix or start-end" style="width:200px" />
  </div>
  <div class="row" style="margin-top:4px">
    <button class="act-btn accent" onclick={requestRemoteCoverage} disabled={remoteCoverageLoading || !selectedMonitorPubkey || !isOnline}>
      {remoteCoverageLoading ? 'Requesting…' : 'Remote Coverage'}
    </button>
    <button class="act-btn" onclick={loadLocalCoverage} disabled={localCoverageLoading}>
      {localCoverageLoading ? 'Reading…' : 'Local Coverage'}
    </button>
    <button class="act-btn accent-soft" onclick={fetchBothCoverage} disabled={bothCoverageLoading || !selectedMonitorPubkey || !isOnline}>
      {bothCoverageLoading ? 'Loading…' : 'Local + Remote'}
    </button>
    {#if remoteCoverageStatus}
      <span class="status" class:ok={remoteCoverageStatus.startsWith('✓')} class:err={remoteCoverageStatus.startsWith('✗')}>{remoteCoverageStatus}</span>
    {/if}
    {#if localCoverageStatus}
      <span class="status" class:ok={localCoverageStatus.startsWith('✓')} class:err={localCoverageStatus.startsWith('✗')}>{localCoverageStatus}</span>
    {/if}
  </div>

  {#if remoteCoverage !== null}
    <div class="cov-source-label">Remote</div>
    {#if remoteCoverage.length === 0}
      <div class="empty">Monitor has no stored footage</div>
    {:else}
      <div class="coverage-list">
        {#each remoteCoverage as [start, end] (start)}
          <div class="cov-row">
            <span class="cov-range">{fmtTs(start)} — {fmtTs(end)}</span>
            <span class="cov-dur">{fmtDur(end - start)}</span>
            <button class="ts-chip" onclick={() => { fetchRangeTs = `${start}-${end}`; copyText(`${start}-${end}`); }} title="Insert range into fetch time range input">{start}-{end}</button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  {#if localCoverage !== null}
    <div class="cov-source-label">Local</div>
    {#if localCoverage.length === 0}
      <div class="empty">Nothing stored locally for this device</div>
    {:else}
      <div class="coverage-list">
        {#each localCoverage as [start, end] (start)}
          <div class="cov-row">
            <span class="cov-range">{fmtTs(start)} — {fmtTs(end)}</span>
            <span class="cov-dur">{fmtDur(end - start)}</span>
            <button class="ts-chip" onclick={() => { fetchRangeTs = `${start}-${end}`; copyText(`${start}-${end}`); }} title="Insert range into fetch time range input">{start}-{end}</button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- Filters + sources row: types · sources · channel -->
  <div class="row" style="margin-top:4px; gap:4px; flex-wrap:wrap;">
    <span class="muted-sep">Types</span>
    {#each (['video/', 'audio/', 'image/'] as MimePrefix[]) as prefix}
      <button class="type-filter-btn" class:active={fetchTypeFilter.has(prefix)} onclick={() => toggleFetchType(prefix)}>
        {TYPE_LABELS[prefix]}
      </button>
    {/each}
    <span class="ctrl-divider">|</span>
    <span class="muted-sep">Sources</span>
    <button class="type-filter-btn" class:active={fetchSourceLocal} onclick={() => toggleFetchSource('local')}
      title="Include locally stored segments (IndexedDB)">
      Local IDB
    </button>
    <button class="type-filter-btn" class:active={fetchSourceRtc} onclick={() => toggleFetchSource('rtc')}
      title="Include segments from the monitor over WebRTC">
      WebRTC
    </button>
    <span class="ctrl-divider">|</span>
    <select class="source-select"
      onchange={(e) => { fetchChannelFilter = (e.target as HTMLSelectElement).value; }}
      disabled={knownChannelIds.length === 0}
      title={knownChannelIds.length === 0 ? 'Load coverage to discover channels' : 'Filter fetch by channel — channels from coverage data'}>
      <option value="" selected={fetchChannelFilter === ''}>All channels</option>
      {#each knownChannelIds as chId (chId)}
        <option value={chId} selected={chId === fetchChannelFilter}>{chId}</option>
      {/each}
    </select>
    {#if knownChannelIds.length === 0}
      <span class="hint-inline">load coverage to filter by channel</span>
    {/if}
  </div>

  <!-- Actions row: ← Earlier · First N · Last N · Later → · counter -->
  <div class="fetch-actions-row">
    <button class="act-btn adj-arrow" onclick={fetchExplicitBefore} disabled={navLoading || fetchLoading}
      title="Fetch {fetchCount === 0 ? 'up to 50' : fetchCount} segment{fetchCount !== 1 ? 's' : ''} before the range start · time range expands if new content is found">
      ← Earlier {fetchCount === 0 ? '∞' : fetchCount}
    </button>
    <button class="act-btn accent" onclick={() => fetchInRange('asc')} disabled={fetchLoading}
      title="Fetch the first {fetchCount === 0 ? 'all' : fetchCount} segments chronologically within the time range">
      {fetchLoading ? '…' : `First ${fetchCount === 0 ? '∞' : fetchCount}`}
    </button>
    <button class="act-btn" onclick={() => fetchInRange('desc')} disabled={fetchLoading}
      title="Fetch the last {fetchCount === 0 ? 'all' : fetchCount} segments chronologically within the time range">
      {fetchLoading ? '…' : `Last ${fetchCount === 0 ? '∞' : fetchCount}`}
    </button>
    <button class="act-btn adj-arrow" onclick={fetchExplicitAfter} disabled={navLoading || fetchLoading}
      title="Fetch {fetchCount === 0 ? 'up to 50' : fetchCount} segment{fetchCount !== 1 ? 's' : ''} after the range end · time range expands if new content is found">
      Later → {fetchCount === 0 ? '∞' : fetchCount}
    </button>
    <div class="stepper" title="Number of segments to fetch (0 = as many as possible)">
      <button class="stepper-btn" onclick={() => fetchCount = Math.max(0, fetchCount - 1)}>−</button>
      <span class="stepper-val">{fetchCount === 0 ? '∞' : fetchCount}</span>
      <button class="stepper-btn" onclick={() => fetchCount = Math.min(50, fetchCount + 1)}>+</button>
    </div>
  </div>

  <div class="hint-row">Already-fetched segments are skipped — fetch again to add new segments to the same list</div>

  {#if fetchStatus || navStatus}
    <div class="fetch-status-row">
      {#if fetchStatus}<span class="status" class:ok={fetchStatus.startsWith('✓')} class:err={fetchStatus.startsWith('✗')}>{fetchStatus}</span>{/if}
      {#if navStatus}<span class="status nav-status-inline" class:nav-warn={navStatus.startsWith('No ')} class:nav-err={navStatus.startsWith('Could')}>{navStatus}</span>{/if}
    </div>
  {/if}

  <!-- ── Fetch by ID ─────────────────────────────────────────────────────── -->
  <div class="subsec-title" style="margin-top:8px">Fetch by Segment / Alert ID</div>
  <div class="row">
    <input class="id-input" bind:value={segIdInput} placeholder="Segment ID or alert refId" type="text" />
    <button class="act-btn accent" onclick={fetchByIdRtc} disabled={segIdLoading || !selectedMonitorPubkey || !isOnline}>
      {segIdLoading ? '…' : 'WebRTC'}
    </button>
    <button class="act-btn" onclick={fetchByIdIdb} disabled={segIdLoading}>
      {segIdLoading ? '…' : 'Local IDB'}
    </button>
  </div>
  {#if segIdStatus}
    <span class="status" class:ok={segIdStatus.startsWith('✓')} class:err={segIdStatus.startsWith('✗')}>{segIdStatus}</span>
  {/if}

  <!-- ── Fetched Segments ───────────────────────────────────────────────────── -->
  {#if fetchedSegs.length > 0}
    <div class="subsec-title-row" style="margin-top:8px">
      <span class="subsec-title" style="margin-top:0">Fetched Segments ({browsedSegsWithIdx.length}{browsedSegsWithIdx.length !== fetchedSegs.length ? ` / ${fetchedSegs.length}` : ''})</span>
      <button class="raw-toggle" class:active={showRaw} onclick={() => showRaw = !showRaw}>Raw</button>
      <button class="act-btn small-danger" onclick={clearSegments}>Clear All</button>
    </div>

    <!-- Segment Viewer -->
    <div class="viewer-box">
      {#if viewerError}
        <div class="viewer-empty viewer-err">{viewerError}</div>
      {:else if currentSeg}
        {#if currentSeg.mimeType.startsWith('image/')}
          <img bind:this={viewerImgEl} alt="Snapshot" class="viewer-media"
            onerror={() => { viewerError = '✗ Could not load image'; }} />
        {:else if currentSeg.mimeType.startsWith('audio/')}
          <audio bind:this={viewerAudioEl} controls onended={handleVideoEnded} class="viewer-audio"
            onerror={() => { viewerError = '✗ Could not load audio'; }}></audio>
        {:else}
          <video bind:this={viewerVideoEl} controls onended={handleVideoEnded} class="viewer-media"
            onerror={() => { viewerError = '✗ Could not load video'; }}></video>
        {/if}
      {:else}
        <div class="viewer-empty">Click Show on a segment below to view it</div>
      {/if}
    </div>

    <!-- Playback controls -->
    <div class="playback-bar">
      <button class="nav-btn" onclick={prevSeg} disabled={navLoading}>←</button>
      <span class="seg-counter">
        {browsedIdx + 1} / {browsedSegsWithIdx.length}
        {#if currentSeg}
          · {fmtTs(currentSeg.startTime)}–{fmtTs(currentSeg.endTime)}
          · {currentSeg.mimeType.startsWith('image/') ? 'photo' : currentSeg.mimeType.startsWith('audio/') ? 'audio' : 'video'}
        {/if}
      </span>
      <button class="nav-btn" onclick={nextSeg} disabled={navLoading}>→</button>
      <span class="sep"></span>
      <label class="toggle-label">
        <input type="checkbox" bind:checked={autoPlayNext} />
        AutoPlay
      </label>
      {#if autoPlayCountdown > 0}
        <span class="countdown">⏱ {autoPlayCountdown}s</span>
      {/if}
    </div>
    <!-- Segment Table -->
    <div class="seg-table-scroll">
    <div class="seg-table">
      <div class="seg-th">
        <span>#</span><span>Src</span><span>Type</span><span>Start</span><span>End</span><span>Dur</span><span>Timestamps</span><span></span><span></span><span></span>
      </div>
      {#each browsedSegsWithIdx as { seg, i }, j (seg.key)}
        <div class="seg-tr" class:active={i === currentIdx}>
          <span class="seg-num">{j + 1}</span>
          <span class="src-badge" class:rtc={seg.source === 'rtc'} class:idb={seg.source === 'idb'}>{seg.source}</span>
          <span class="type-badge" class:is-video={seg.mimeType.startsWith('video/')} class:is-audio={seg.mimeType.startsWith('audio/')} class:is-img={seg.mimeType.startsWith('image/')}>
            {seg.mimeType.startsWith('image/') ? 'photo' : seg.mimeType.startsWith('audio/') ? 'audio' : 'video'}
          </span>
          <span class="seg-time">{fmtTs(seg.startTime)}</span>
          <span class="seg-time">{fmtTs(seg.endTime)}</span>
          <span class="seg-dur">{fmtDur(seg.endTime - seg.startTime)}</span>
          <span class="ts-chips">
            <button class="ts-chip" onclick={() => copyText(`${seg.startTime}-${seg.endTime}`)}>{seg.startTime}-{seg.endTime}</button>
            {#if seg.segmentId}
              <button class="ts-chip id-ts" onclick={() => copyText(seg.segmentId!)}>{seg.segmentId.slice(0, 8)}…</button>
            {/if}
            {#if fetchedDeviceIds.length > 1}
              <button class="ts-chip dev-chip" onclick={() => copyText(seg.originMonitor)} title={seg.originMonitor}>📷{seg.originMonitor.slice(0, 6)}</button>
            {/if}
          </span>
          <button class="show-btn" class:active-show={i === currentIdx} onclick={() => showSeg(i)}>
            {i === currentIdx ? '▶ Showing' : 'Show'}
          </button>
          {#if seg.source === 'rtc'}
            {#if savedKeys.has(seg.key)}
              <span class="saved-badge">✓ Saved</span>
            {:else}
              <button class="save-btn" onclick={() => saveSeg(i)} disabled={savingKeys.has(seg.key) || !selectedMonitorPubkey}>
                {savingKeys.has(seg.key) ? '…' : 'Save'}
              </button>
            {/if}
          {:else}
            <span></span>
          {/if}
          <button class="remove-btn" onclick={() => removeSeg(i)} title="Remove from list">×</button>
        </div>
        {#if showRaw}
          <div class="seg-raw">
            <pre>{JSON.stringify(
              seg.source === 'rtc'
                ? { key: seg.key, source: seg.source, mimeType: seg.mimeType, startTime: seg.startTime, endTime: seg.endTime, monitorSegmentId: seg.segmentId ?? null, channelId: seg.channelId ?? null, sizeBytes: seg.blob.size }
                : { key: seg.key, source: seg.source, mimeType: seg.mimeType, startTime: seg.startTime, endTime: seg.endTime, segmentId: seg.segmentId ?? null, channelId: seg.channelId ?? null, backupOf: seg.backupOf ?? null, sizeBytes: seg.blob.size }
            , null, 2)}</pre>
          </div>
        {/if}
      {/each}
    </div>
    </div>
  {/if}

  <LogPanel sources={['rtc', 'idb']} />
</DevSection>

<style>
  .subsec-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 4px; }
  .subsec-title-row { display: flex; align-items: center; gap: 8px; }
  .raw-toggle { font-size: 9px; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: ui-monospace, monospace; }
  .raw-toggle:hover { color: var(--color-text); }
  .raw-toggle.active { background: rgba(139,92,246,0.15); color: var(--color-accent); border-color: var(--color-accent); }
  .seg-raw { background: var(--color-surface); border-top: 1px solid var(--color-border); padding: 4px 8px; }
  .seg-raw pre { margin: 0; font-size: 9px; font-family: ui-monospace, monospace; color: var(--color-muted); white-space: pre-wrap; word-break: break-all; line-height: 1.4; }

  /* General Player */
  .player-box { width: 100%; background: #000; border-radius: 6px; min-height: 140px; display: flex; align-items: center; justify-content: center; overflow: hidden; margin-top: 4px; position: relative; }
  .player-media { width: 100%; max-height: 260px; border-radius: 6px; display: block; object-fit: contain; }
  .player-empty { font-size: 10px; color: var(--color-muted); text-align: center; padding: 20px; }
  .player-scrubber-row { margin-top: 4px; }
  .player-scrubber { width: 100%; cursor: pointer; accent-color: var(--color-accent); }
  .player-pos { font-size: 10px; color: var(--color-muted); font-family: ui-monospace, monospace; flex: 1; }
  .vol-label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--color-muted); cursor: default; white-space: nowrap; }
  .vol-slider { width: 64px; cursor: pointer; accent-color: var(--color-accent); }
  .vol-pct { font-size: 9px; font-family: ui-monospace, monospace; color: var(--color-muted); min-width: 28px; }

  /* Segment viewer (inside fetched segments) */
  .viewer-box { width: 100%; background: #000; border-radius: 6px; min-height: 100px; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; margin-top: 4px; }
  .viewer-media { width: 100%; max-height: 220px; border-radius: 6px; display: block; object-fit: contain; }
  .viewer-audio { width: 100%; padding: 16px; box-sizing: border-box; }
  .viewer-empty { font-size: 10px; color: var(--color-muted); text-align: center; padding: 16px; }
  .viewer-err { color: var(--color-danger); }

  .playback-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .nav-btn { font-size: 14px; padding: 2px 10px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); cursor: pointer; }
  .nav-btn:disabled { opacity: 0.3; cursor: default; }
  .nav-btn:hover:not(:disabled) { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .seg-counter { font-size: 10px; color: var(--color-muted); font-family: ui-monospace, monospace; flex: 1; }
  .sep { flex: 1; }
  .toggle-label { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--color-muted); cursor: pointer; }
  .toggle-label input { cursor: pointer; }
  .countdown { font-size: 11px; color: var(--color-warning); font-family: ui-monospace, monospace; }
  .act-btn.small-danger { font-size: 9px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--color-danger); background: none; color: var(--color-danger); cursor: pointer; }
  .act-btn.small-danger:hover { background: var(--color-danger); color: white; }

  /* Fetch actions row — adjacent arrows + fetch buttons + count stepper, all inline */
  .fetch-actions-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
  .adj-arrow { font-weight: 600; }
  .ctrl-divider { color: var(--color-border); font-size: 12px; padding: 0 2px; }

  /* Count stepper — visible +/- buttons flanking the value */
  .stepper { display: flex; align-items: stretch; border: 1px solid var(--color-border); border-radius: 4px; overflow: hidden; margin-left: auto; }
  .stepper-btn { font-size: 13px; line-height: 1; padding: 0 7px; min-height: 22px; border: none; background: var(--color-surface); color: var(--color-muted); cursor: pointer; transition: background 0.12s, color 0.12s; }
  .stepper-btn:hover { background: var(--color-accent); color: white; }
  .stepper-val { font-size: 10px; padding: 2px 8px; min-width: 26px; text-align: center; color: var(--color-text); font-family: ui-monospace, monospace; border-left: 1px solid var(--color-border); border-right: 1px solid var(--color-border); display: flex; align-items: center; justify-content: center; }

  /* Combined fetch + nav status line */
  .fetch-status-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 3px; }
  .nav-status-inline { font-family: ui-monospace, monospace; }
  .nav-status-inline.nav-warn { color: var(--color-warning, #f59e0b); }
  .nav-status-inline.nav-err { color: var(--color-danger); }

  /* Time range */
  .range-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .date-input { font-size: 11px; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: inherit; }
  .ts-input { font-size: 11px; padding: 3px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: ui-monospace, monospace; width: 130px; }
  .muted-sep { font-size: 10px; color: var(--color-muted); }
  .type-filter-btn { font-size: 9px; padding: 2px 7px; border-radius: 10px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; }
  .type-filter-btn:hover { color: var(--color-text); border-color: var(--color-text); }
  .type-filter-btn.active { background: rgba(139,92,246,0.15); color: var(--color-accent); border-color: var(--color-accent); font-weight: 600; }

  /* Coverage */
  .cov-source-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-muted); margin-top: 6px; margin-bottom: 2px; }
  .coverage-list { display: flex; flex-direction: column; gap: 2px; }
  .cov-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; background: var(--color-surface); font-size: 11px; }
  .cov-range { font-family: ui-monospace, monospace; color: var(--color-text); }
  .cov-dur { color: var(--color-muted); font-size: 10px; flex: 1; }

  /* Segment table */
  .seg-table-scroll { max-height: 240px; overflow-y: auto; border: 1px solid var(--color-border); border-radius: 5px; margin-bottom: 4px; }
  .seg-table { display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
  .seg-th { display: grid; grid-template-columns: 24px 36px 44px 1fr 1fr 36px 1fr 56px 46px 18px; gap: 4px; padding: 3px 8px; background: var(--color-surface); font-size: 9px; color: var(--color-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .seg-tr { display: grid; grid-template-columns: 24px 36px 44px 1fr 1fr 36px 1fr 56px 46px 18px; gap: 4px; padding: 3px 8px; align-items: center; font-size: 10px; background: var(--color-bg); border-top: 1px solid var(--color-border); }
  .seg-tr.active { background: rgba(139,92,246,0.08); }
  .seg-num { color: var(--color-muted); font-family: ui-monospace, monospace; }
  .src-badge { font-size: 8px; padding: 1px 4px; border-radius: 3px; text-align: center; font-weight: 700; }
  .src-badge.rtc { background: rgba(59,130,246,0.15); color: #60a5fa; }
  .src-badge.idb { background: rgba(34,197,94,0.12); color: var(--color-success); }
  .type-badge { font-size: 8px; padding: 1px 4px; border-radius: 3px; text-align: center; }
  .type-badge.is-video { background: rgba(139,92,246,0.15); color: #a78bfa; }
  .type-badge.is-audio { background: rgba(59,130,246,0.15); color: #60a5fa; }
  .type-badge.is-img { background: rgba(251,146,60,0.15); color: #fb923c; }
  .seg-time { font-family: ui-monospace, monospace; color: var(--color-text); font-size: 10px; }
  .seg-dur { color: var(--color-muted); }
  .ts-chips { display: flex; gap: 3px; flex-wrap: wrap; }
  .show-btn { font-size: 9px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; white-space: nowrap; }
  .show-btn:hover { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .show-btn.active-show { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .save-btn { font-size: 9px; padding: 2px 6px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; white-space: nowrap; }
  .save-btn:hover:not(:disabled) { background: var(--color-success); color: white; border-color: var(--color-success); }
  .save-btn:disabled { opacity: 0.4; cursor: default; }
  .saved-badge { font-size: 9px; color: var(--color-success); white-space: nowrap; }
  .remove-btn { font-size: 11px; line-height: 1; padding: 1px 3px; border-radius: 3px; border: 1px solid transparent; background: none; color: var(--color-muted); cursor: pointer; }
  .remove-btn:hover { background: var(--color-danger); color: white; border-color: var(--color-danger); }

  /* Fetch by ID */
  .id-input { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text); font-family: ui-monospace, monospace; flex: 1; min-width: 0; }

  /* Shared */
  .ts-chip { font-family: ui-monospace, monospace; font-size: 9px; padding: 1px 4px; border-radius: 3px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; white-space: nowrap; }
  .ts-chip:hover { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .ts-chip.id-ts { color: var(--color-accent); }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .act-btn { font-size: 10px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-muted); cursor: pointer; font-family: inherit; white-space: nowrap; }
  .act-btn:hover:not(:disabled) { color: var(--color-text); }
  .act-btn:disabled { opacity: 0.4; cursor: default; }
  .act-btn.accent { background: var(--color-accent); color: white; border-color: var(--color-accent); }
  .act-btn.accent-soft { background: rgba(139,92,246,0.15); color: var(--color-accent); border-color: var(--color-accent); }
  .act-btn.accent-soft:hover:not(:disabled) { background: var(--color-accent); color: white; }
  .status { font-size: 10px; }
  .status.ok { color: var(--color-success); }
  .status.err { color: var(--color-danger); }
  .source-select { font-size: 10px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-bg); color: var(--color-text); font-family: ui-monospace, monospace; max-width: 160px; }
  .empty { font-size: 11px; color: var(--color-muted); padding: 4px 0; }
  .priority-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
  .prio-chip { display: flex; align-items: center; gap: 2px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 4px; padding: 1px 4px; font-size: 9px; }
  .prio-rank { color: var(--color-accent); font-family: ui-monospace, monospace; min-width: 14px; }
  .prio-name { color: var(--color-text); font-family: ui-monospace, monospace; }
  .prio-btn { font-size: 9px; padding: 0 3px; border: none; background: none; color: var(--color-muted); cursor: pointer; line-height: 1.2; }
  .prio-btn:hover { color: var(--color-accent); }

  /* Inline and block hint text */
  .hint-row { font-size: 9px; color: var(--color-muted); margin-top: 3px; margin-bottom: 1px; font-style: italic; opacity: 0.75; }
  .hint-inline { font-size: 9px; color: var(--color-muted); font-style: italic; opacity: 0.75; }

  /* Device chip in segment table — only visible when multiple monitors are loaded */
  .dev-chip { color: var(--color-warning, #f59e0b); }
</style>
