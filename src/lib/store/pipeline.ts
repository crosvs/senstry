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
	type: 'audio' | 'schedule' | 'timewindow' | 'daterange' | 'nostr-trigger';
	sourceId: string;  // 'none' for schedule/timewindow/daterange/nostr-trigger
	enabled: boolean;
	// ── audio fields ──────────────────────────────────────────────────────────
	thresholdDb: number;
	// releaseThresholdDb: hysteresis lower bound — stays active until avgDb drops here.
	releaseThresholdDb?: number;
	minDurationMs: number;
	// settlingMs: debounce after threshold drops before sensor declares idle.
	settlingMs: number;
	// ── schedule fields ───────────────────────────────────────────────────────
	intervalMs?: number;
	// ── timewindow fields ─────────────────────────────────────────────────────
	// Active hour-slots: (dayOfWeek * 24 + hour), 0=Sun 00:00 … 167=Sat 23:00.
	activeSlots?: number[];
	// ── daterange fields ──────────────────────────────────────────────────────
	startIso?: string;
	endIso?: string;
	// ── nostr-trigger fields ──────────────────────────────────────────────────
	monitorPubkey?: string;
	// nostrChannelId: named to avoid shadowing Action.channelId in UI state.
	nostrChannelId?: string | null;
	detectionTypes?: string[];
}

export type CaptureMethod =
	| { id: string; name: string; type: 'video';  sourceId: string;
	    videoWidth: number; videoHeight: number;
	    videoBitsPerSec: number; videoCodec: string; }
	| { id: string; name: string; type: 'audio';  sourceId: string;
	    audioBitsPerSec: number; mimeType: string; }
	| { id: string; name: string; type: 'photo';  sourceId: string;
	    imageWidth: number; imageHeight: number; imageQuality: number; imageFormat: string; };

// A channel bundles a video source + audio source into a named recording/streaming unit.
export interface ChannelConfig {
	id: string;
	name: string;
	videoSourceId: string | null;
	audioSourceId: string | null;
}

// ── Action types ──────────────────────────────────────────────────────────────
// Actions own their configuration and runtime state (Active / Cooldown / Idle).
// Links are stateless wires that connect sensors to actions.

/** Keep channel recording at a quality level while triggered (always-on rolling buffer). */
export interface RecordAction {
	id: string;
	name: string;
	type: 'record';
	channelId: string;
	captureIds: string[];          // video and/or audio CaptureMethods; multiple allowed
	priority: number;              // highest wins when multiple RecordActions compete for a channel slot
	postRollSec: number;           // keep recording this long after all triggering links deactivate
	rollingBufferSec: number | null; // null = infinite; evicts unpinned segments older than this
	onRetrigger: 'extend' | 'ignore' | 'restart';
}

/** Pin a footage window from a channel on trigger (protect segments from rolling buffer eviction). */
export interface ClipAction {
	id: string;
	name: string;
	type: 'clip';
	channelId: string;
	captureTypes: ('video' | 'audio' | 'photo')[];  // which capture types from channel to pin
	preRollSec: number;
	postRollSec: number;
	pinLifetimeSec: number;         // seconds to pin; 0 = keep forever
	onRetrigger: 'extend' | 'ignore' | 'restart';
}

/** Take a photo burst on trigger and optionally pin the resulting images. */
export interface SnapshotAction {
	id: string;
	name: string;
	type: 'snapshot';
	channelId: string;
	captureId: string;              // must reference a photo CaptureMethod
	snapshotCount: number;          // 0 = unlimited while triggered
	intervalSec: number;
	pinLifetimeSec: number | null;
}

/** Publish a Nostr trigger event on sensor state transitions. */
export interface NotifyAction {
	id: string;
	name: string;
	type: 'notify';
	cooldownMs: number;
	onRetrigger: 'ignore' | 'extend' | 'restart'; // behaviour when sensor fires during cooldown
	includeData: boolean;
	messageTemplate?: string;
	viewerPubkey: string | null;    // null = broadcast to all paired devices
	publishStates: ('sensing' | 'active' | 'idle')[];
}

export type Action = RecordAction | ClipAction | SnapshotAction | NotifyAction;

// ── Link (stateless — owns conditions, not state) ─────────────────────────────

export interface Link {
	id: string;
	name: string;
	enabled: boolean;
	sensorIds: string[];              // sensors to evaluate
	condition: 'any' | 'all';        // any sensor in onState, or all of them
	onState: 'sensing' | 'active';   // which sensor state level counts as "on"
	actionIds: string[];
}

// ── Storage cleanup ───────────────────────────────────────────────────────────

export interface ThinningRule {
	afterAgeSec: number;
	keepOnePerSec: number;
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
		{ afterAgeSec: 3600,   keepOnePerSec: 30,    mimePrefix: 'video/' },
		{ afterAgeSec: 21600,  keepOnePerSec: 60,    mimePrefix: 'video/' },
		{ afterAgeSec: 43200,  keepOnePerSec: 300,   mimePrefix: 'video/' },
		{ afterAgeSec: 86400,  keepOnePerSec: 900,   mimePrefix: 'video/' },
		{ afterAgeSec: 259200, keepOnePerSec: 3600,  mimePrefix: 'video/' },
		{ afterAgeSec: 604800, keepOnePerSec: 21600, mimePrefix: 'video/' },
		{ afterAgeSec: 86400,  keepOnePerSec: 60,    mimePrefix: 'image/' },
		{ afterAgeSec: 604800, keepOnePerSec: 3600,  mimePrefix: 'image/' },
		{ afterAgeSec: 604800, keepOnePerSec: 3600,  mimePrefix: 'audio/' },
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
	| { status: 'idle'; nextFireAt?: number }
	| { status: 'sensing';  startedAt: number; minDurationMs: number }
	| { status: 'active';   startedAt: number }
	| { status: 'settling'; endsAt: number };

export type ActionState =
	| { status: 'idle' }
	| { status: 'active'; startedAt: number }
	| { status: 'cooldown'; endsAt: number };

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_SOURCES: SourceConfig[] = [
	{ id: 'default-cam', name: '', type: 'camera',     deviceId: '' },
	{ id: 'default-mic', name: '', type: 'microphone', deviceId: '' },
];

export const DEFAULT_SENSORS: SensorConfig[] = [
	{
		id: 'default-audio-bg', name: 'Background noise', type: 'audio', sourceId: 'default-mic',
		enabled: true, thresholdDb: -56, releaseThresholdDb: -60, minDurationMs: 500, settlingMs: 1000,
	},
	{
		id: 'default-audio-med', name: 'Medium noise (long)', type: 'audio', sourceId: 'default-mic',
		enabled: true, thresholdDb: -45, releaseThresholdDb: -56, minDurationMs: 5000, settlingMs: 10000,
	},
	{
		id: 'default-audio-loud', name: 'Loud noise (short)', type: 'audio', sourceId: 'default-mic',
		enabled: true, thresholdDb: -24, releaseThresholdDb: -45, minDurationMs: 1000, settlingMs: 5000,
	},
	{
		id: 'default-schedule', name: '', type: 'schedule', sourceId: 'none',
		enabled: true, thresholdDb: 0, minDurationMs: 0, settlingMs: 1000, intervalMs: 10000,
	},
];

export const DEFAULT_CAPTURES: CaptureMethod[] = [
	{
		id: 'default-video-lo', name: 'Low quality CAM', type: 'video',
		sourceId: 'default-cam', videoWidth: 1280, videoHeight: 720, videoBitsPerSec: 800_000, videoCodec: '',
	},
	{
		id: 'default-video-hi', name: 'High quality CAM', type: 'video',
		sourceId: 'default-cam', videoWidth: 0, videoHeight: 0, videoBitsPerSec: 2_400_000, videoCodec: '',
	},
	{
		id: 'default-audio-clip', name: 'Audio from MIC', type: 'audio',
		sourceId: 'default-mic', audioBitsPerSec: 64_000, mimeType: '',
	},
	{
		id: 'default-photo', name: 'Photo from CAM', type: 'photo',
		sourceId: 'default-cam', imageWidth: 0, imageHeight: 0, imageQuality: 0.85, imageFormat: 'image/jpeg',
	},
];

export const DEFAULT_CHANNELS: ChannelConfig[] = [
	{ id: 'default-channel', name: 'Main channel', videoSourceId: 'default-cam', audioSourceId: 'default-mic' },
];

export const DEFAULT_ACTIONS: Action[] = [
	{
		id: 'default-record-lo', name: '', type: 'record',
		channelId: 'default-channel', captureIds: ['default-video-lo', 'default-audio-clip'],
		priority: 1, postRollSec: 20, rollingBufferSec: null, onRetrigger: 'extend',
	},
	{
		id: 'default-record-hi', name: '', type: 'record',
		channelId: 'default-channel', captureIds: ['default-video-hi', 'default-audio-clip'],
		priority: 10, postRollSec: 10, rollingBufferSec: null, onRetrigger: 'extend',
	},
	{
		id: 'default-snapshot-burst', name: '', type: 'snapshot',
		channelId: 'default-channel', captureId: 'default-photo',
		snapshotCount: 5, intervalSec: 2, pinLifetimeSec: null,
	},
	{
		id: 'default-snapshot-tick', name: '', type: 'snapshot',
		channelId: 'default-channel', captureId: 'default-photo',
		snapshotCount: 1, intervalSec: 0, pinLifetimeSec: null,
	},
	{
		id: 'default-clip', name: '', type: 'clip',
		channelId: 'default-channel', captureTypes: ['audio', 'photo'],
		preRollSec: 10, postRollSec: 10, pinLifetimeSec: 7 * 24 * 3600, onRetrigger: 'extend',
	},
	{
		id: 'default-notify', name: '', type: 'notify',
		cooldownMs: 30_000, onRetrigger: 'ignore', includeData: true,
		viewerPubkey: null, publishStates: ['active'], messageTemplate: 'Loud noise detected',
	},
];

export const DEFAULT_LINKS: Link[] = [
	{
		id: 'default-link-bg', name: '', enabled: true,
		sensorIds: ['default-audio-bg'], condition: 'any', onState: 'active',
		actionIds: ['default-record-lo'],
	},
	{
		id: 'default-link-med', name: '', enabled: true,
		sensorIds: ['default-audio-med'], condition: 'any', onState: 'active',
		actionIds: ['default-record-hi'],
	},
	{
		id: 'default-link-schedule', name: '', enabled: true,
		sensorIds: ['default-schedule'], condition: 'any', onState: 'active',
		actionIds: ['default-snapshot-tick'],
	},
	{
		id: 'default-link-loud', name: '', enabled: true,
		sensorIds: ['default-audio-loud'], condition: 'any', onState: 'active',
		actionIds: ['default-clip', 'default-snapshot-burst', 'default-notify'],
	},
];

// ── Stores ────────────────────────────────────────────────────────────────────

export const sources  = writable<SourceConfig[]>(DEFAULT_SOURCES);
export const sensors  = writable<SensorConfig[]>(DEFAULT_SENSORS);
export const captures = writable<CaptureMethod[]>(DEFAULT_CAPTURES);
export const channels = writable<ChannelConfig[]>(DEFAULT_CHANNELS);
export const actions  = writable<Action[]>(DEFAULT_ACTIONS);
export const links    = writable<Link[]>(DEFAULT_LINKS);

// ── Persistence ───────────────────────────────────────────────────────────────

export async function loadPipeline(): Promise<void> {
	const [ss, sn, cp, na, ch, lk, ac] = await Promise.all([
		getSetting<SourceConfig[]>('pipeline.sources'),
		getSetting<SensorConfig[]>('pipeline.sensors'),
		getSetting<CaptureMethod[]>('pipeline.captures'),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		getSetting<any[]>('pipeline.nostrActions'),   // legacy key
		getSetting<ChannelConfig[]>('pipeline.channels'),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		getSetting<any[]>('pipeline.links'),
		getSetting<Action[]>('pipeline.actions'),
	]);

	const hasPipeline = ss || sn || cp || na || ch || lk || ac;
	if (!hasPipeline) {
		// Check for legacy keys before deciding what to do.
		const [oldTriggers, oldSettings] = await Promise.all([
			getSetting<unknown[]>('triggers'),
			getSetting<{ videoConfig?: unknown; photoConfig?: unknown }>('app.settings'),
		]);
		const hasLegacy = oldTriggers?.length || oldSettings?.videoConfig || oldSettings?.photoConfig;
		if (hasLegacy) {
			await _migrateFromLegacy();
		} else {
			// Truly fresh install — bootstrap with current defaults directly.
			await savePipeline({
				sources:  DEFAULT_SOURCES,
				sensors:  DEFAULT_SENSORS,
				captures: DEFAULT_CAPTURES,
				channels: DEFAULT_CHANNELS,
				actions:  DEFAULT_ACTIONS,
				links:    DEFAULT_LINKS,
			});
		}
		return;
	}

	if (ss?.length) sources.set(ss);
	if (sn?.length) sensors.set(sn);
	if (cp?.length) {
		// Strip legacy `priority` field from CaptureMethod records.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		captures.set(cp.map((c: any) => { const { priority: _p, ...rest } = c; return rest as CaptureMethod; }));
	}
	if (ch?.length) channels.set(ch);

	// Migrate old nostrActions + old typed links → new actions + links
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const hasOldLinks = lk?.some((l: any) => 'type' in l || 'sensorId' in l);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const hasNewLinks = lk?.some((l: any) => 'sensorIds' in l);

	if (hasOldLinks && !hasNewLinks) {
		const { newActions, newLinks: migratedLinks } = _migrateTypedLinks(lk ?? [], na ?? []);
		await savePipeline({ actions: newActions, links: migratedLinks });
		// Clear the old nostrActions key
		await putSetting('pipeline.nostrActions', null);
	} else {
		if (ac?.length) {
			// Backfill onRetrigger on NotifyActions that predate the field, and
			// coerce null pinLifetimeSec on ClipActions to 0 (pin forever).
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			actions.set(ac.map((a: any): Action => {
				if (a.type === 'notify' && !('onRetrigger' in a)) return { ...a, onRetrigger: 'ignore' } as NotifyAction;
				if (a.type === 'clip' && a.pinLifetimeSec == null) return { ...a, pinLifetimeSec: 7 * 24 * 3600 } as ClipAction;
				return a as Action;
			}));
		}
		else if (na?.length) {
			// nostrActions exists but no typed links migration needed — convert to NotifyActions
			const notifyActions: NotifyAction[] = na.map(a => ({
				id: a.id, name: a.name ?? '', type: 'notify' as const,
				cooldownMs: a.cooldownMs ?? 30_000, onRetrigger: (a.onRetrigger ?? 'ignore') as NotifyAction['onRetrigger'],
				includeData: a.includeData ?? true,
				messageTemplate: a.messageTemplate,
				viewerPubkey: a.viewerPubkey ?? null,
				publishStates: a.publishStates ?? ['active'],
			}));
			const merged = [...DEFAULT_ACTIONS.filter(a => a.type !== 'notify'), ...notifyActions];
			await savePipeline({ actions: merged });
			await putSetting('pipeline.nostrActions', null);
		}
		if (hasNewLinks) links.set(lk!.filter((l: any) => 'sensorIds' in l).map((l: any): Link => {
			// Migrate old single actionId → actionIds array
			if (!('actionIds' in l)) {
				const { actionId, ...rest } = l;
				return { ...rest, actionIds: actionId ? [actionId] : [] } as Link;
			}
			return l as Link;
		}));
	}
}

export async function savePipeline(parts: {
	sources?:  SourceConfig[];
	sensors?:  SensorConfig[];
	captures?: CaptureMethod[];
	channels?: ChannelConfig[];
	actions?:  Action[];
	links?:    Link[];
}): Promise<void> {
	const ops: Promise<void>[] = [];
	if (parts.sources  !== undefined) ops.push(putSetting('pipeline.sources',  parts.sources).then(()  => sources.set(parts.sources!)));
	if (parts.sensors  !== undefined) ops.push(putSetting('pipeline.sensors',  parts.sensors).then(()  => sensors.set(parts.sensors!)));
	if (parts.captures !== undefined) ops.push(putSetting('pipeline.captures', parts.captures).then(() => captures.set(parts.captures!)));
	if (parts.channels !== undefined) ops.push(putSetting('pipeline.channels', parts.channels).then(() => channels.set(parts.channels!)));
	if (parts.actions  !== undefined) ops.push(putSetting('pipeline.actions',  parts.actions).then(()  => actions.set(parts.actions!)));
	if (parts.links    !== undefined) ops.push(putSetting('pipeline.links',    parts.links).then(()    => links.set(parts.links!)));
	await Promise.all(ops);
}

// ── Migration: old typed links → new actions + stateless links ────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _migrateTypedLinks(oldLinks: any[], oldNostrActions: any[]): { newActions: Action[]; newLinks: Link[] } {
	const newActions: Action[] = [];
	const newLinks: Link[] = [];

	// Convert old NostrActions → NotifyActions (deduplicated by id)
	const notifyMap = new Map<string, NotifyAction>();
	for (const na of oldNostrActions) {
		notifyMap.set(na.id, {
			id: na.id, name: na.name ?? '', type: 'notify',
			cooldownMs: na.cooldownMs ?? 30_000, onRetrigger: (na.onRetrigger ?? 'ignore') as NotifyAction['onRetrigger'],
			includeData: na.includeData ?? true,
			messageTemplate: na.messageTemplate,
			viewerPubkey: na.viewerPubkey ?? null,
			publishStates: na.publishStates ?? ['active'],
		});
	}

	for (const l of oldLinks) {
		// Already in new format — also migrate actionId → actionIds if needed
		if ('sensorIds' in l) {
			if (!('actionIds' in l)) {
				const { actionId, ...rest } = l;
				newLinks.push({ ...rest, actionIds: actionId ? [actionId] : [] } as Link);
			} else {
				newLinks.push(l as Link);
			}
			continue;
		}

		const sensorIds = l.sensorId ? [l.sensorId] : [];
		const onState: Link['onState'] = l.onState === 'sensing' ? 'sensing' : 'active';

		if (l.type === 'record') {
			const act: RecordAction = {
				id: `act-${l.id}`, name: l.name ?? '',
				type: 'record',
				channelId: l.channelId ?? 'default-channel',
				captureIds: l.captureIds ?? (l.captureId ? [l.captureId] : []),
				priority: l.priority ?? 10,
				postRollSec: l.postRollSec ?? 30,
				rollingBufferSec: l.rollingBufferSec ?? null,
				onRetrigger: l.onRetrigger ?? 'extend',
			};
			newActions.push(act);
			newLinks.push({ id: `lnk-${l.id}`, name: l.name ?? '', enabled: l.enabled ?? true, sensorIds, condition: 'any', onState, actionIds: [act.id] });
		} else if (l.type === 'pin' || l.type === 'clip') {
			const act: ClipAction = {
				id: `act-${l.id}`, name: l.name ?? '',
				type: 'clip',
				channelId: l.channelId ?? 'default-channel',
				captureTypes: l.captureTypes ?? ['audio'],
				preRollSec: l.preRollSec ?? 30,
				postRollSec: l.postRollSec ?? 30,
				pinLifetimeSec: l.pinLifetimeSec ?? null,
				onRetrigger: l.onRetrigger ?? 'extend',
			};
			newActions.push(act);
			newLinks.push({ id: `lnk-${l.id}`, name: l.name ?? '', enabled: l.enabled ?? true, sensorIds, condition: 'any', onState, actionIds: [act.id] });
		} else if (l.type === 'photo' || l.type === 'snapshot') {
			const act: SnapshotAction = {
				id: `act-${l.id}`, name: l.name ?? '',
				type: 'snapshot',
				channelId: l.channelId ?? 'default-channel',
				captureId: l.captureId ?? '',
				snapshotCount: l.snapshotCount ?? 1,
				intervalSec: l.intervalSec ?? 5,
				pinLifetimeSec: l.pinLifetimeSec ?? null,
			};
			newActions.push(act);
			newLinks.push({ id: `lnk-${l.id}`, name: l.name ?? '', enabled: l.enabled ?? true, sensorIds, condition: 'any', onState, actionIds: [act.id] });
		} else if (l.type === 'action') {
			// Find or create NotifyAction from nostrActionId
			let act = notifyMap.get(l.nostrActionId);
			if (!act) {
				act = {
					id: l.nostrActionId || `act-notify-${l.id}`, name: '',
					type: 'notify', cooldownMs: 30_000, onRetrigger: 'ignore' as const,
					includeData: true, viewerPubkey: null, publishStates: l.publishStates ?? ['active'],
				};
				notifyMap.set(act.id, act);
			} else {
				// Merge publishStates from link into action
				const extra = (l.publishStates ?? []).filter((s: string) => !act!.publishStates.includes(s as 'sensing' | 'active' | 'idle'));
				if (extra.length) act = { ...act, publishStates: [...act.publishStates, ...extra] as ('sensing' | 'active' | 'idle')[] };
				notifyMap.set(act.id, act);
			}
			newLinks.push({ id: `lnk-${l.id}`, name: l.name ?? '', enabled: l.enabled ?? true, sensorIds, condition: 'any', onState, actionIds: [act.id] });
		}
	}

	// Add all collected NotifyActions
	newActions.push(...notifyMap.values());

	return {
		newActions: newActions.length ? newActions : DEFAULT_ACTIONS,
		newLinks:   newLinks.length   ? newLinks   : DEFAULT_LINKS,
	};
}

// ── Legacy migration (very old app.settings format) ───────────────────────────

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
	const newActions: Action[] = [];
	const newLinks: Link[] = [];

	const triggers = oldTriggers?.length ? oldTriggers : [
		{ id: 'default', name: 'Audio', type: 'audio', enabled: true,
		  thresholdDb: -40, cooldownMs: 2000, minDurationMs: 500, notifyCooldownMs: 30_000 }
	];

	for (const t of triggers) {
		if (t.type !== 'audio') continue;
		newSensors.push({
			id: t.id, name: '', type: 'audio', sourceId: 'default-mic',
			enabled: t.enabled, thresholdDb: t.thresholdDb,
			releaseThresholdDb: t.thresholdDb,
			minDurationMs: t.minDurationMs, settlingMs: t.cooldownMs,
		});

		const notifyAction: NotifyAction = {
			id: `notify-${t.id}`, name: '', type: 'notify',
			cooldownMs: t.notifyCooldownMs ?? 30_000, onRetrigger: 'ignore',
			includeData: true, viewerPubkey: null, publishStates: ['active'],
		};
		newActions.push(notifyAction);

		const action = t.action ?? 'video';

		if ((action === 'video' || action === 'both') && vc) {
			const capId = `cap-video-${t.id}`;
			const cap: CaptureMethod = vc.recordVideo
				? { id: capId, name: '', type: 'video', sourceId: 'default-cam',
				    videoWidth: vc.videoWidth, videoHeight: vc.videoHeight,
				    videoBitsPerSec: vc.videoBitsPerSec, videoCodec: vc.videoCodec }
				: { id: capId, name: '', type: 'audio', sourceId: 'default-mic',
				    audioBitsPerSec: vc.audioBitsPerSec || 64_000, mimeType: '' };
			newCaptures.push(cap);

			const recordAct: RecordAction = {
				id: `act-rec-${t.id}`, name: '', type: 'record',
				channelId: 'default-channel', captureIds: [capId],
				priority: 10, postRollSec: vc.postRollSec, rollingBufferSec: null, onRetrigger: 'extend',
			};
			const clipAct: ClipAction = {
				id: `act-clip-${t.id}`, name: '', type: 'clip',
				channelId: 'default-channel', captureTypes: ['audio'],
				preRollSec: vc.preRollSec, postRollSec: vc.postRollSec,
				pinLifetimeSec: vc.pinLifetimeSec ?? 7 * 24 * 3600, onRetrigger: 'extend',
			};
			newActions.push(recordAct, clipAct);
			newLinks.push(
				{ id: `lnk-rec-${t.id}`, name: '', enabled: vc.enabled, sensorIds: [t.id], condition: 'any', onState: 'active', actionIds: [recordAct.id] },
				{ id: `lnk-clip-${t.id}`, name: '', enabled: vc.enabled, sensorIds: [t.id], condition: 'any', onState: 'active', actionIds: [clipAct.id] },
				{ id: `lnk-ntf-${t.id}`, name: '', enabled: vc.enabled, sensorIds: [t.id], condition: 'any', onState: 'active', actionIds: [notifyAction.id] },
			);
		}

		if ((action === 'photo' || action === 'both') && pc) {
			const capId = `cap-photo-${t.id}`;
			newCaptures.push({
				id: capId, name: '', type: 'photo', sourceId: 'default-cam',
				imageWidth: pc.imageWidth, imageHeight: 0, imageQuality: pc.imageQuality, imageFormat: pc.imageFormat,
			});
			const snapAct: SnapshotAction = {
				id: `act-snap-${t.id}`, name: '', type: 'snapshot',
				channelId: 'default-channel', captureId: capId,
				snapshotCount: pc.snapshotCount, intervalSec: pc.intervalSec,
				pinLifetimeSec: pc.pinLifetimeSec,
			};
			newActions.push(snapAct);
			newLinks.push({ id: `lnk-snap-${t.id}`, name: '', enabled: pc.enabled, sensorIds: [t.id], condition: 'any', onState: 'active', actionIds: [snapAct.id] });
			if (!newLinks.some(l => l.actionIds.includes(notifyAction.id))) {
				newLinks.push({ id: `lnk-ntf-${t.id}`, name: '', enabled: pc.enabled, sensorIds: [t.id], condition: 'any', onState: 'active', actionIds: [notifyAction.id] });
			}
		}

		// Fallback: audio-only pipeline
		if (!newLinks.some(l => l.sensorIds.includes(t.id))) {
			const capId = `cap-audio-${t.id}`;
			newCaptures.push({ id: capId, name: '', type: 'audio', sourceId: 'default-mic', audioBitsPerSec: 64_000, mimeType: '' });
			const recordAct: RecordAction = {
				id: `act-rec-${t.id}`, name: '', type: 'record',
				channelId: 'default-channel', captureIds: [capId],
				priority: 10, postRollSec: 30, rollingBufferSec: null, onRetrigger: 'extend',
			};
			const clipAct: ClipAction = {
				id: `act-clip-${t.id}`, name: '', type: 'clip',
				channelId: 'default-channel', captureTypes: ['audio'],
				preRollSec: 30, postRollSec: 30, pinLifetimeSec: 7 * 24 * 3600, onRetrigger: 'extend',
			};
			newActions.push(recordAct, clipAct);
			newLinks.push(
				{ id: `lnk-rec-${t.id}`, name: '', enabled: true, sensorIds: [t.id], condition: 'any', onState: 'active', actionIds: [recordAct.id] },
				{ id: `lnk-clip-${t.id}`, name: '', enabled: true, sensorIds: [t.id], condition: 'any', onState: 'active', actionIds: [clipAct.id] },
				{ id: `lnk-ntf-${t.id}`, name: '', enabled: true, sensorIds: [t.id], condition: 'any', onState: 'active', actionIds: [notifyAction.id] },
			);
		}
	}

	await savePipeline({
		sources:  newSources,
		sensors:  newSensors.length  ? newSensors  : DEFAULT_SENSORS,
		captures: newCaptures.length ? newCaptures : DEFAULT_CAPTURES,
		channels: DEFAULT_CHANNELS,
		actions:  newActions.length  ? newActions  : DEFAULT_ACTIONS,
		links:    newLinks.length    ? newLinks    : DEFAULT_LINKS,
	});
}

// ── Factory functions ─────────────────────────────────────────────────────────

export function newSource(type: SourceConfig['type'] = 'microphone'): SourceConfig {
	return { id: randomUUID(), name: '', type, deviceId: '' };
}

function _nightSlots(): number[] {
	const slots: number[] = [];
	const eveningDays = [1, 2, 3, 4, 5];
	const morningDays = [2, 3, 4, 5, 6];
	for (const d of eveningDays) { for (let h = 22; h < 24; h++) slots.push(d * 24 + h); }
	for (const d of morningDays) { for (let h = 0; h < 6; h++) slots.push(d * 24 + h); }
	return slots;
}

export function newSensor(sourceId: string, type: SensorConfig['type'] = 'audio'): SensorConfig {
	if (type === 'schedule') return { id: randomUUID(), name: '', type: 'schedule', sourceId: 'none', enabled: true, thresholdDb: 0, minDurationMs: 0, settlingMs: 1000, intervalMs: 60_000 };
	if (type === 'timewindow') return { id: randomUUID(), name: '', type: 'timewindow', sourceId: 'none', enabled: true, thresholdDb: 0, minDurationMs: 0, settlingMs: 0, activeSlots: _nightSlots() };
	if (type === 'daterange') {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
		return { id: randomUUID(), name: '', type: 'daterange', sourceId: 'none', enabled: true, thresholdDb: 0, minDurationMs: 0, settlingMs: 0, startIso: toIso(now), endIso: toIso(new Date(now.getTime() + 24 * 3600_000)) };
	}
	if (type === 'nostr-trigger') return { id: randomUUID(), name: '', type: 'nostr-trigger', sourceId: 'none', enabled: true, thresholdDb: 0, minDurationMs: 0, settlingMs: 2000, monitorPubkey: '', nostrChannelId: null, detectionTypes: [] };
	return { id: randomUUID(), name: '', type: 'audio', sourceId, enabled: true, thresholdDb: -45, releaseThresholdDb: -50, minDurationMs: 1500, settlingMs: 500 };
}

export function newCapture(sourceId: string, type: CaptureMethod['type'] = 'audio'): CaptureMethod {
	if (type === 'video') return { id: randomUUID(), name: '', type: 'video', sourceId, videoWidth: 0, videoHeight: 0, videoBitsPerSec: 0, videoCodec: '' };
	if (type === 'photo') return { id: randomUUID(), name: '', type: 'photo', sourceId, imageWidth: 0, imageHeight: 0, imageQuality: 0.85, imageFormat: 'image/jpeg' };
	return { id: randomUUID(), name: '', type: 'audio', sourceId, audioBitsPerSec: 64_000, mimeType: '' };
}

export function newChannel(): ChannelConfig {
	return { id: randomUUID(), name: '', videoSourceId: null, audioSourceId: null };
}

export function newLink(actionIds: string[] = []): Link {
	return { id: randomUUID(), name: '', enabled: true, sensorIds: [], condition: 'any', onState: 'active', actionIds };
}

export function newRecordAction(channelId: string): RecordAction {
	return { id: randomUUID(), name: '', type: 'record', channelId, captureIds: [], priority: 10, postRollSec: 30, rollingBufferSec: null, onRetrigger: 'extend' };
}

export function newClipAction(channelId: string): ClipAction {
	return { id: randomUUID(), name: '', type: 'clip', channelId, captureTypes: ['audio'], preRollSec: 30, postRollSec: 30, pinLifetimeSec: 7 * 24 * 3600, onRetrigger: 'extend' };
}

export function newSnapshotAction(channelId: string): SnapshotAction {
	return { id: randomUUID(), name: '', type: 'snapshot', channelId, captureId: '', snapshotCount: 1, intervalSec: 5, pinLifetimeSec: 7 * 24 * 3600 };
}

export function newNotifyAction(): NotifyAction {
	return { id: randomUUID(), name: '', type: 'notify', cooldownMs: 30_000, onRetrigger: 'ignore', includeData: true, viewerPubkey: null, publishStates: ['active'] };
}

// ── Auto-name utilities ───────────────────────────────────────────────────────

function _srcLabel(sourceId: string, sources: SourceConfig[]): string {
	const s = sources.find(x => x.id === sourceId);
	return s?.name || (s?.type === 'screen' ? 'Screen' : s?.type === 'camera' ? 'Camera' : 'Mic');
}

export function autoNameSensor(s: SensorConfig, sources: SourceConfig[] = []): string {
	if (s.type === 'audio') {
		const src = _srcLabel(s.sourceId, sources);
		const avgS    = (s.minDurationMs / 1000).toFixed(1);
		const settleS = (s.settlingMs    / 1000).toFixed(1);
		return `Audio on ${src} (${s.thresholdDb} dB, avg ${avgS}s, settle ${settleS}s)`;
	}
	if (s.type === 'schedule') {
		const sec = Math.round((s.intervalMs ?? 60_000) / 1000);
		if (sec < 60) return `Timer: every ${sec}s`;
		const min = Math.round(sec / 60);
		return min < 60 ? `Timer: every ${min} min` : `Timer: every ${Math.round(min / 60)}h`;
	}
	if (s.type === 'timewindow') {
		const slots = s.activeSlots ?? [];
		if (!slots.length) return 'Time Window (inactive)';
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
	if (s.type === 'nostr-trigger') {
		const peer = s.monitorPubkey ? s.monitorPubkey.slice(0, 8) + '…' : '(unset)';
		return `Nostr Trigger from ${peer}`;
	}
	return 'Sensor';
}

export function autoNameCapture(c: CaptureMethod, sources: SourceConfig[] = []): string {
	const src = _srcLabel(c.sourceId, sources);
	if (c.type === 'video') {
		const res   = c.videoWidth      > 0 ? `${c.videoWidth}p ` : '';
		const vkbps = c.videoBitsPerSec > 0 ? `${Math.round(c.videoBitsPerSec / 1000)} kbps` : 'auto';
		return `${res}Video from ${src} (${vkbps})`;
	}
	if (c.type === 'audio') {
		const kbps = c.audioBitsPerSec > 0 ? `${Math.round(c.audioBitsPerSec / 1000)} kbps` : 'auto bitrate';
		return `Audio Clip from ${src} (${kbps})`;
	}
	const dims = c.imageWidth > 0 ? `${c.imageWidth}px` : 'auto';
	const fmt  = c.imageFormat ? (c.imageFormat.split('/')[1] ?? c.imageFormat).toUpperCase() : 'JPEG';
	return `Photo from ${src} (${dims} ${fmt})`;
}

export function autoNameChannel(c: ChannelConfig, sources: SourceConfig[] = []): string {
	const vid = c.videoSourceId ? _srcLabel(c.videoSourceId, sources) : null;
	const aud = c.audioSourceId ? _srcLabel(c.audioSourceId, sources) : null;
	if (vid && aud) return `${vid} + ${aud}`;
	if (vid) return `Video: ${vid}`;
	if (aud) return `Audio: ${aud}`;
	return 'Empty channel';
}

export function autoNameAction(
	a: Action,
	captures: CaptureMethod[] = [],
	channelConfigs: ChannelConfig[] = [],
	sources: SourceConfig[] = [],
): string {
	const ch = 'channelId' in a ? channelConfigs.find(x => x.id === a.channelId) : null;
	const chLabel = ch ? ` [${ch.name || autoNameChannel(ch, sources)}]` : '';

	if (a.type === 'record') {
		const capLabels = a.captureIds.length
			? a.captureIds.map(id => { const c = captures.find(x => x.id === id); return c ? (c.name || autoNameCapture(c, sources)) : '[capture]'; }).join(' + ')
			: '(no capture)';
		return `Record ${capLabels}${chLabel}`;
	}
	if (a.type === 'clip') {
		const types = a.captureTypes.length ? a.captureTypes.join('+') : 'any';
		const rollLabel = `${a.preRollSec}s+${a.postRollSec}s`;
		return `Clip ${types} ${rollLabel}${chLabel}`;
	}
	if (a.type === 'snapshot') {
		const cap = a.captureId ? captures.find(x => x.id === a.captureId) : null;
		const capLabel = cap ? ` (${cap.name || autoNameCapture(cap, sources)})` : '';
		const countLabel = a.snapshotCount > 0 ? `×${a.snapshotCount}` : '∞';
		return `Snapshot ${countLabel}${capLabel}${chLabel}`;
	}
	// notify
	const sec = Math.round(a.cooldownMs / 1000);
	const coolLabel = !sec ? 'no cooldown' : sec < 60 ? `${sec}s` : `${Math.round(sec / 60)} min cooldown`;
	return `Notify (${coolLabel})`;
}

export function autoNameLink(
	l: Link,
	sensors: SensorConfig[] = [],
	actionList: Action[] = [],
	sources: SourceConfig[] = [],
): string {
	const sensorLabels = l.sensorIds.map(id => {
		const s = sensors.find(x => x.id === id);
		return s ? (s.name || autoNameSensor(s, sources)) : '[sensor]';
	});
	const from = sensorLabels.length
		? (l.condition === 'all' ? sensorLabels.join(' AND ') : sensorLabels.join(' OR '))
		: '(no sensor)';
	const actLabels = l.actionIds.map(id => {
		const a = actionList.find(x => x.id === id);
		return a ? (a.name || autoNameAction(a)) : '(?)';
	});
	const actLabel = actLabels.length ? actLabels.join(' + ') : '(no action)';
	return `${from} → ${actLabel}`;
}
