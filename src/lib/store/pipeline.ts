import { writable } from 'svelte/store';
import { getSetting, putSetting } from '$lib/db/idb';
import { randomUUID } from '$lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SourceConfig {
	id: string;
	name: string;
	type: 'camera' | 'microphone' | 'screen';
	deviceId: string;        // '' = browser default (unused for screen)
	videoWidth?: number;
	videoHeight?: number;
	frameRate?: number;      // camera/screen: requested fps (ideal constraint)
	audioSampleRate?: number; // microphone: requested sample rate (ideal constraint)
}

export interface SensorConfig {
	id: string;
	name: string;
	type: 'audio' | 'schedule' | 'timewindow' | 'daterange';
	sourceId: string;
	enabled: boolean;
	thresholdDb: number;
	// releaseThresholdDb: hysteresis lower bound — once active, sensor stays active until avgDb
	// drops below this value. If omitted, defaults to thresholdDb (no hysteresis zone).
	releaseThresholdDb?: number;
	minDurationMs: number;
	// settlingMs: detection debounce — how long after threshold drops before the sensor
	// declares itself idle. Distinct from link.postRollSec (recording tail after sensor idle).
	settlingMs: number;
	// intervalMs: for schedule sensors — how often to fire (ms)
	intervalMs?: number;
	// timewindow: active hour-slots as (dayOfWeek * 24 + hour), 0=Sun 00:00 … 167=Sat 23:00
	// Empty/undefined = no active hours (sensor never fires).
	activeSlots?: number[];
	// daterange fields
	startIso?: string;       // ISO datetime e.g. "2026-05-10T22:00"
	endIso?: string;
}

export type CaptureMethod =
	| { id: string; name: string; type: 'video';  sourceId: string;
	    videoWidth: number; videoHeight: number;
	    videoBitsPerSec: number; audioBitsPerSec: number; videoCodec: string;
	    // audioSourceId: mix audio from a separate source (e.g. mic) into the video recording.
	    // Empty string = use audio tracks from the video source (if any).
	    audioSourceId?: string; }
	| { id: string; name: string; type: 'audio';  sourceId: string;
	    audioBitsPerSec: number; mimeType: string; }
	| { id: string; name: string; type: 'photo';  sourceId: string;
	    imageWidth: number; imageHeight: number; imageQuality: number; imageFormat: string; };

export interface NostrAction {
	id: string;
	name: string;
	cooldownMs: number;
	includeData: boolean;    // include raw sensor values (peakDb, durationMs, etc.)
	messageTemplate?: string;
}

// A channel bundles a video source + audio source into a named RTC output.
// Viewers subscribe to a channel; the monitor sends video tracks from videoSourceId
// and audio tracks from audioSourceId, composited into a single stream.
// channelId on Link tags footage refs so content can be filtered per channel.
export interface ChannelConfig {
	id: string;
	name: string;
	videoSourceId: string | null;   // which source provides video tracks; null = no video
	audioSourceId: string | null;   // which source provides audio tracks; null = no audio
}

export interface Link {
	id: string;
	name: string;
	enabled: boolean;
	sensorId: string;
	onState: 'sensing' | 'active';
	// minStateDurationMs: sensor must hold onState for this long before link activates (0 = immediate)
	minStateDurationMs: number;
	captureId:        string | null;  // null = no capture (notify-only or profile-switch)
	nostrActionId:    string | null;  // null = no broadcast
	channelId:        string | null;  // output channel for RTC routing + footage tagging
	// priority: when multiple links compete for the same source's recorder slot, higher wins.
	// Only applies to non-photo captures (photos are always fire-and-forget).
	priority:         number;
	preRollSec:       number;         // how far back to pin existing segments on activation
	postRollSec:      number;         // how long after sensor idle before link deactivates
	snapshotCount:    number;         // photo captures only
	intervalSec:      number;         // photo captures only
	onRetrigger:      'extend' | 'ignore' | 'restart';
	// 'restart' is naturally debounced by sensor.settlingMs
	pinLifetimeSec:   number | null;  // null = don't pin
	// rollingBufferSec: seconds of rolling footage kept available for pre-roll pinning.
	// null = infinite; storage thinning/quota rules manage deletion instead.
	// Should be ≥ preRollSec for pre-roll to capture the full requested window.
	rollingBufferSec: number | null;
}

// ── Storage cleanup ───────────────────────────────────────────────────────────

export interface ThinningRule {
	afterAgeSec: number;    // thin segments older than this
	keepOnePerSec: number;  // within that age range, keep at most 1 segment per this many seconds
	// '' = all types; 'image/' = photos only; 'video/' = video clips; 'audio/' = audio clips
	mimePrefix: string;
}

export interface StorageCleanupConfig {
	quotaMb: number;
	thinningRules: ThinningRule[];
	autoCleanupEnabled: boolean;
	autoCleanupIntervalSec: number;
}

export const DEFAULT_STORAGE_CLEANUP: StorageCleanupConfig = {
	quotaMb: 500,
	thinningRules: [
		{ afterAgeSec: 3600,  keepOnePerSec: 60,   mimePrefix: 'image/' },  // >1h: keep 1 photo/min
		{ afterAgeSec: 86400, keepOnePerSec: 3600,  mimePrefix: 'image/' },  // >1d: keep 1 photo/hr
		{ afterAgeSec: 3600,  keepOnePerSec: 3600,  mimePrefix: 'audio/' },  // >1h: keep 1 audio clip/hr
		{ afterAgeSec: 3600,  keepOnePerSec: 3600,  mimePrefix: 'video/' },  // >1h: keep 1 video clip/hr
	],
	autoCleanupEnabled: true,
	autoCleanupIntervalSec: 300,
};

export const storageCleanup = writable<StorageCleanupConfig>({ ...DEFAULT_STORAGE_CLEANUP });

export async function loadStorageCleanup(): Promise<void> {
	const stored = await getSetting<StorageCleanupConfig>('pipeline.storageCleanup');
	if (stored) storageCleanup.set(stored);
}

export async function saveStorageCleanup(config: StorageCleanupConfig): Promise<void> {
	await putSetting('pipeline.storageCleanup', config);
	storageCleanup.set(config);
}

// ── Runtime states (not stored) ───────────────────────────────────────────────

export type SensorState =
	| { status: 'inactive' }
	| { status: 'idle'; nextFireAt?: number }  // nextFireAt: used by schedule sensors to show countdown
	| { status: 'sensing';  startedAt: number; minDurationMs: number }
	| { status: 'active';   startedAt: number }
	| { status: 'settling'; endsAt: number };

export type LinkActivationState =
	| { status: 'inactive' }
	| { status: 'waiting'; startedAt: number; minMs: number }
	| { status: 'active';  startedAt: number };

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_SOURCES: SourceConfig[] = [
	{ id: 'default-mic', name: 'Default Microphone', type: 'microphone', deviceId: '' },
	{ id: 'default-cam', name: 'Default Camera',     type: 'camera',     deviceId: '' },
];

export const DEFAULT_SENSORS: SensorConfig[] = [
	{
		id: 'default-audio', name: 'Audio', type: 'audio', sourceId: 'default-mic',
		enabled: true, thresholdDb: -45, releaseThresholdDb: -50, minDurationMs: 1500, settlingMs: 500,
	},
];

export const DEFAULT_CAPTURES: CaptureMethod[] = [
	{
		id: 'default-audio-clip', name: 'Audio Clip', type: 'audio',
		sourceId: 'default-mic', audioBitsPerSec: 64_000, mimeType: '',
	},
];

export const DEFAULT_NOSTR_ACTIONS: NostrAction[] = [
	{ id: 'default-notify', name: 'Notify All', cooldownMs: 30_000, includeData: true },
];

export const DEFAULT_CHANNELS: ChannelConfig[] = [
	{ id: 'default-channel', name: 'Main', videoSourceId: null, audioSourceId: 'default-mic' },
];

export const DEFAULT_LINKS: Link[] = [
	{
		id: 'default-link', name: 'Audio → Clip + Notify',
		enabled: true, sensorId: 'default-audio', onState: 'active',
		minStateDurationMs: 0,
		captureId: 'default-audio-clip', nostrActionId: 'default-notify',
		channelId: 'default-channel', priority: 10,
		preRollSec: 30, postRollSec: 30,
		snapshotCount: 0, intervalSec: 0,
		onRetrigger: 'extend', pinLifetimeSec: 7 * 24 * 3600,
		rollingBufferSec: null,
	},
];

// ── Stores ────────────────────────────────────────────────────────────────────

export const sources      = writable<SourceConfig[]>(DEFAULT_SOURCES);
export const sensors      = writable<SensorConfig[]>(DEFAULT_SENSORS);
export const captures     = writable<CaptureMethod[]>(DEFAULT_CAPTURES);
export const nostrActions = writable<NostrAction[]>(DEFAULT_NOSTR_ACTIONS);
export const channels     = writable<ChannelConfig[]>(DEFAULT_CHANNELS);
export const links        = writable<Link[]>(DEFAULT_LINKS);

// ── Persistence ───────────────────────────────────────────────────────────────

export async function loadPipeline(): Promise<void> {
	const [ss, sn, cp, na, ch, lk] = await Promise.all([
		getSetting<SourceConfig[]>('pipeline.sources'),
		getSetting<SensorConfig[]>('pipeline.sensors'),
		getSetting<CaptureMethod[]>('pipeline.captures'),
		getSetting<NostrAction[]>('pipeline.nostrActions'),
		getSetting<ChannelConfig[]>('pipeline.channels'),
		getSetting<Link[]>('pipeline.links'),
	]);
	// If no pipeline data exists yet, attempt migration from legacy trigger/settings keys.
	// Otherwise load whatever is stored (falling back to defaults for any missing keys).
	const hasPipeline = ss || sn || cp || na || ch || lk;
	if (!hasPipeline) {
		await _migrateFromLegacy();
		return;
	}
	if (ss?.length)  sources.set(ss);
	if (sn?.length)  sensors.set(sn);
	if (cp?.length)  captures.set(cp);
	if (na?.length)  nostrActions.set(na);
	if (ch?.length)  channels.set(ch);
	if (lk?.length)  links.set(lk);
}

export async function savePipeline(parts: {
	sources?:      SourceConfig[];
	sensors?:      SensorConfig[];
	captures?:     CaptureMethod[];
	nostrActions?: NostrAction[];
	channels?:     ChannelConfig[];
	links?:        Link[];
}): Promise<void> {
	const ops: Promise<void>[] = [];
	if (parts.sources !== undefined)      ops.push(putSetting('pipeline.sources',      parts.sources).then(()      => sources.set(parts.sources!)));
	if (parts.sensors !== undefined)      ops.push(putSetting('pipeline.sensors',      parts.sensors).then(()      => sensors.set(parts.sensors!)));
	if (parts.captures !== undefined)     ops.push(putSetting('pipeline.captures',     parts.captures).then(()     => captures.set(parts.captures!)));
	if (parts.nostrActions !== undefined) ops.push(putSetting('pipeline.nostrActions', parts.nostrActions).then(() => nostrActions.set(parts.nostrActions!)));
	if (parts.channels !== undefined)     ops.push(putSetting('pipeline.channels',     parts.channels).then(()     => channels.set(parts.channels!)));
	if (parts.links !== undefined)        ops.push(putSetting('pipeline.links',        parts.links).then(()        => links.set(parts.links!)));
	await Promise.all(ops);
}

// ── Legacy migration ──────────────────────────────────────────────────────────

interface LegacyTriggerConfig {
	id: string; name: string; type: string; action?: string; enabled: boolean;
	thresholdDb: number; cooldownMs: number; minDurationMs: number; notifyCooldownMs?: number;
}
interface LegacyVideoConfig {
	triggerId?: string; preRollSec: number; postRollSec: number; recordVideo: boolean;
	videoWidth: number; videoHeight: number; videoBitsPerSec: number; audioBitsPerSec: number;
	videoCodec: string; enabled: boolean; pinLifetimeSec: number | null;
}
interface LegacyPhotoConfig {
	triggerId?: string; snapshotCount: number; intervalSec: number;
	imageWidth: number; imageQuality: number; imageFormat: string;
	enabled: boolean; pinLifetimeSec: number | null;
}
interface LegacyAppSettings { videoConfig?: LegacyVideoConfig; photoConfig?: LegacyPhotoConfig; }

async function _migrateFromLegacy(): Promise<void> {
	const oldTriggers = await getSetting<LegacyTriggerConfig[]>('triggers');
	const oldSettings = await getSetting<LegacyAppSettings>('app.settings');
	const vc = oldSettings?.videoConfig;
	const pc = oldSettings?.photoConfig;

	const newSources: SourceConfig[] = [...DEFAULT_SOURCES];
	const newSensors: SensorConfig[] = [];
	const newCaptures: CaptureMethod[] = [];
	const newNostrActions: NostrAction[] = [];
	const newLinks: Link[] = [];

	const triggers = oldTriggers?.length ? oldTriggers : [
		{ id: 'default', name: 'Audio', type: 'audio', enabled: true,
		  thresholdDb: -40, cooldownMs: 2000, minDurationMs: 500, notifyCooldownMs: 30_000 }
	];

	for (const t of triggers) {
		if (t.type !== 'audio') continue;
		const sensor: SensorConfig = {
			id: t.id, name: t.name, type: 'audio', sourceId: 'default-mic',
			enabled: t.enabled, thresholdDb: t.thresholdDb,
			releaseThresholdDb: t.thresholdDb,
			minDurationMs: t.minDurationMs, settlingMs: t.cooldownMs,
		};
		newSensors.push(sensor);

		const notifyAction: NostrAction = {
			id: `notify-${t.id}`, name: `Notify (${t.name})`,
			cooldownMs: t.notifyCooldownMs ?? 30_000, includeData: true,
		};
		newNostrActions.push(notifyAction);

		// Build capture methods from legacy video/photo configs
		const action = t.action ?? 'video';
		const captureIds: string[] = [];

		if ((action === 'video' || action === 'both') && vc) {
			const capId = `cap-video-${t.id}`;
			const cap: CaptureMethod = vc.recordVideo
				? { id: capId, name: 'Video Clip', type: 'video', sourceId: 'default-cam',
				    videoWidth: vc.videoWidth, videoHeight: vc.videoHeight,
				    videoBitsPerSec: vc.videoBitsPerSec, audioBitsPerSec: vc.audioBitsPerSec,
				    videoCodec: vc.videoCodec }
				: { id: capId, name: 'Audio Clip', type: 'audio', sourceId: 'default-mic',
				    audioBitsPerSec: vc.audioBitsPerSec || 64_000, mimeType: '' };
			newCaptures.push(cap);
			captureIds.push(capId);
			const link: Link = {
				id: `link-video-${t.id}`, name: `${t.name} → ${cap.name}`,
				enabled: vc.enabled, sensorId: t.id, onState: 'active',
				minStateDurationMs: 0,
				captureId: capId, nostrActionId: notifyAction.id,
				channelId: null, priority: 10,
				preRollSec: vc.preRollSec, postRollSec: vc.postRollSec,
				snapshotCount: 0, intervalSec: 0,
				onRetrigger: 'extend', pinLifetimeSec: vc.pinLifetimeSec,
				rollingBufferSec: null,
			};
			newLinks.push(link);
		}

		if ((action === 'photo' || action === 'both') && pc) {
			const capId = `cap-photo-${t.id}`;
			const cap: CaptureMethod = {
				id: capId, name: 'Photo Burst', type: 'photo', sourceId: 'default-cam',
				imageWidth: pc.imageWidth, imageHeight: 0, imageQuality: pc.imageQuality, imageFormat: pc.imageFormat,
			};
			newCaptures.push(cap);
			const hasVideoLink = newLinks.some(l => l.sensorId === t.id);
			const link: Link = {
				id: `link-photo-${t.id}`, name: `${t.name} → Photo Burst`,
				enabled: pc.enabled, sensorId: t.id, onState: 'active',
				minStateDurationMs: 0,
				captureId: capId,
				nostrActionId: hasVideoLink ? null : notifyAction.id,
				channelId: null, priority: 5,
				preRollSec: 0, postRollSec: 0,
				snapshotCount: pc.snapshotCount, intervalSec: pc.intervalSec,
				onRetrigger: 'ignore', pinLifetimeSec: pc.pinLifetimeSec,
				rollingBufferSec: null,
			};
			newLinks.push(link);
		}

		// If no captures were configured, create a default audio-only link
		if (newLinks.filter(l => l.sensorId === t.id).length === 0) {
			const capId = `cap-audio-${t.id}`;
			newCaptures.push({
				id: capId, name: 'Audio Clip', type: 'audio',
				sourceId: 'default-mic', audioBitsPerSec: 64_000, mimeType: '',
			});
			newLinks.push({
				id: `link-audio-${t.id}`, name: `${t.name} → Audio Clip`,
				enabled: true, sensorId: t.id, onState: 'active',
				minStateDurationMs: 0,
				captureId: capId, nostrActionId: notifyAction.id,
				channelId: null, priority: 10,
				preRollSec: 30, postRollSec: 30,
				snapshotCount: 0, intervalSec: 0,
				onRetrigger: 'extend', pinLifetimeSec: 7 * 24 * 3600,
				rollingBufferSec: null,
			});
		}
	}

	const pipeline = {
		sources: newSources,
		sensors: newSensors.length ? newSensors : DEFAULT_SENSORS,
		captures: newCaptures.length ? newCaptures : DEFAULT_CAPTURES,
		nostrActions: newNostrActions.length ? newNostrActions : DEFAULT_NOSTR_ACTIONS,
		links: newLinks.length ? newLinks : DEFAULT_LINKS,
	};
	await savePipeline(pipeline);
}

// ── Factory functions ─────────────────────────────────────────────────────────

export function newSource(): SourceConfig {
	return { id: randomUUID(), name: 'New Source', type: 'microphone', deviceId: '' };
}

// Generates 168 slots for a typical weekday night window (Mon–Fri 22:00–06:00)
function _nightSlots(): number[] {
	const slots: number[] = [];
	// Mon=1 … Fri=5 for the evening portion (22:00–23:00); Tue=2 … Sat=6 for the morning portion (00:00–05:59)
	const eveningDays = [1, 2, 3, 4, 5]; // Mon–Fri nights
	const morningDays = [2, 3, 4, 5, 6]; // Tue–Sat mornings
	for (const d of eveningDays) { for (let h = 22; h < 24; h++) slots.push(d * 24 + h); }
	for (const d of morningDays) { for (let h = 0; h < 6; h++) slots.push(d * 24 + h); }
	return slots;
}

export function newSensor(sourceId: string, type: SensorConfig['type'] = 'audio'): SensorConfig {
	if (type === 'schedule') {
		return {
			id: randomUUID(), name: 'Periodic Timer', type: 'schedule',
			sourceId: 'none', enabled: true,
			thresholdDb: 0, minDurationMs: 0, settlingMs: 1000, intervalMs: 60_000,
		};
	}
	if (type === 'timewindow') {
		return {
			id: randomUUID(), name: 'Time Window', type: 'timewindow',
			sourceId: 'none', enabled: true,
			thresholdDb: 0, minDurationMs: 0, settlingMs: 0,
			activeSlots: _nightSlots(),
		};
	}
	if (type === 'daterange') {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const toIso = (d: Date) =>
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
		const end = new Date(now.getTime() + 24 * 3600_000);
		return {
			id: randomUUID(), name: 'Date Range', type: 'daterange',
			sourceId: 'none', enabled: true,
			thresholdDb: 0, minDurationMs: 0, settlingMs: 0,
			startIso: toIso(now), endIso: toIso(end),
		};
	}
	return {
		id: randomUUID(), name: 'Audio Detection', type: 'audio',
		sourceId, enabled: true,
		thresholdDb: -45, releaseThresholdDb: -50, minDurationMs: 1500, settlingMs: 500,
	};
}

export function newCapture(sourceId: string, type: CaptureMethod['type'] = 'audio'): CaptureMethod {
	if (type === 'video') {
		return {
			id: randomUUID(), name: '', type: 'video',
			sourceId,
			videoWidth: 0, videoHeight: 0, videoBitsPerSec: 0, audioBitsPerSec: 64_000, videoCodec: '',
			audioSourceId: '',
		};
	}
	if (type === 'photo') {
		return {
			id: randomUUID(), name: '', type: 'photo',
			sourceId, imageWidth: 640, imageHeight: 0, imageQuality: 0.85, imageFormat: 'image/jpeg',
		};
	}
	return {
		id: randomUUID(), name: '', type: 'audio',
		sourceId, audioBitsPerSec: 64_000, mimeType: '',
	};
}

export function newNostrAction(): NostrAction {
	return { id: randomUUID(), name: '', cooldownMs: 30_000, includeData: true };
}

export function newChannel(): ChannelConfig {
	return { id: randomUUID(), name: '', videoSourceId: null, audioSourceId: null };
}

export function newLink(sensorId: string): Link {
	return {
		id: randomUUID(), name: '', enabled: true,
		sensorId, onState: 'active', minStateDurationMs: 0,
		captureId: null, nostrActionId: null,
		channelId: null, priority: 10,
		preRollSec: 30, postRollSec: 30,
		snapshotCount: 3, intervalSec: 2,
		onRetrigger: 'extend', pinLifetimeSec: 7 * 24 * 3600,
		rollingBufferSec: null,
	};
}

// ── Auto-name utilities ───────────────────────────────────────────────────────
// Generate a descriptive label from a node's configuration.
// Used as placeholder= in name inputs and as display text when name is empty.

function _srcLabel(sourceId: string, sources: SourceConfig[]): string {
	const s = sources.find(x => x.id === sourceId);
	return s?.name || (s?.type === 'screen' ? 'Screen' : s?.type === 'camera' ? 'Camera' : 'Mic');
}

export function autoNameSensor(s: SensorConfig, sources: SourceConfig[] = []): string {
	if (s.type === 'audio') {
		const src = _srcLabel(s.sourceId, sources);
		const avgS  = (s.minDurationMs / 1000).toFixed(1);
		const settleS = (s.settlingMs  / 1000).toFixed(1);
		return `Audio on ${src} (${s.thresholdDb} dB, avg ${avgS}s, settle ${settleS}s)`;
	}
	if (s.type === 'schedule') {
		const sec = Math.round((s.intervalMs ?? 60_000) / 1000);
		if (sec < 60)  return `Timer: every ${sec}s`;
		const min = Math.round(sec / 60);
		return min < 60 ? `Timer: every ${min} min` : `Timer: every ${Math.round(min / 60)}h`;
	}
	if (s.type === 'timewindow') {
		const slots = s.activeSlots ?? [];
		if (!slots.length)   return 'Time Window (inactive)';
		if (slots.length === 168) return 'Time Window (24/7)';
		const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const days = [...new Set(slots.map(v => Math.floor(v / 24)))].sort((a, b) => a - b);
		return `Time Window (${days.map(d => DAY[d]).join(', ')})`;
	}
	if (s.type === 'daterange') {
		const start = s.startIso?.slice(0, 10) ?? '?';
		const end   = s.endIso?.slice(0, 10)   ?? '?';
		return start === end ? `Date Range (${start})` : `${start} → ${end}`;
	}
	return 'Sensor';
}

export function autoNameCapture(c: CaptureMethod, sources: SourceConfig[] = []): string {
	const src = _srcLabel(c.sourceId, sources);
	if (c.type === 'video') {
		const res   = c.videoWidth      > 0 ? `${c.videoWidth}p `                                : '';
		const vkbps = c.videoBitsPerSec > 0 ? `${Math.round(c.videoBitsPerSec / 1000)} kbps` : 'auto';
		const akbps = c.audioBitsPerSec > 0 ? ` + ${Math.round(c.audioBitsPerSec / 1000)} kbps audio` : '';
		return `${res}Video from ${src} (${vkbps}${akbps})`;
	}
	if (c.type === 'audio') {
		const kbps = c.audioBitsPerSec > 0 ? `${Math.round(c.audioBitsPerSec / 1000)} kbps` : 'auto bitrate';
		return `Audio Clip from ${src} (${kbps})`;
	}
	// photo
	const dims = c.imageWidth > 0 ? `${c.imageWidth}px` : 'auto';
	const fmt  = c.imageFormat ? (c.imageFormat.split('/')[1] ?? c.imageFormat).toUpperCase() : 'JPEG';
	return `Photo from ${src} (${dims} ${fmt})`;
}

export function autoNameNostrAction(a: NostrAction): string {
	const sec = Math.round(a.cooldownMs / 1000);
	if (!sec) return 'Notify (no cooldown)';
	return sec < 60 ? `Notify (${sec}s)` : `Notify (${Math.round(sec / 60)} min cooldown)`;
}

export function autoNameChannel(c: ChannelConfig, sources: SourceConfig[] = []): string {
	const vid = c.videoSourceId ? _srcLabel(c.videoSourceId, sources) : null;
	const aud = c.audioSourceId ? _srcLabel(c.audioSourceId, sources) : null;
	if (vid && aud) return `${vid} + ${aud}`;
	if (vid) return `Video: ${vid}`;
	if (aud) return `Audio: ${aud}`;
	return 'Empty channel';
}

export function autoNameLink(
	l: Link,
	sensors: SensorConfig[] = [],
	captures: CaptureMethod[] = [],
	nostrActions: NostrAction[] = [],
	sources: SourceConfig[] = [],
	channelConfigs: ChannelConfig[] = [],
): string {
	const sen = sensors.find(x => x.id === l.sensorId);
	const cap = captures.find(x => x.id === l.captureId);
	const act = nostrActions.find(x => x.id === l.nostrActionId);
	const ch  = channelConfigs.find(x => x.id === l.channelId);
	const from = sen ? (sen.name || autoNameSensor(sen, sources)) : '?';
	const to: string[] = [];
	if (cap) to.push(cap.name || autoNameCapture(cap, sources));
	if (act) to.push('Notify');
	const chLabel = ch ? ` [${ch.name || autoNameChannel(ch, sources)}]` : '';
	return to.length ? `${from} → ${to.join(' + ')}${chLabel}` : `${from} (no output)${chLabel}`;
}
