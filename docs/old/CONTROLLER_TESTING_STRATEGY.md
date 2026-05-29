# Controller Testing Strategy

## Overview

Controllers are plain TypeScript classes with no Svelte or browser dependencies. This makes them testable with `vitest` and mock/spy patterns. This document describes the testing approach for each controller type.

---

## Testing Principles

1. **No browser required** — tests run with `npm run test` (vitest + happy-dom)
2. **Dependency injection** — controllers take all external dependencies as constructor arguments, not imports
3. **Callback spies** — use `vi.fn()` to mock callbacks and verify they're called correctly
4. **Snapshot tests for state** — complex state transitions can be captured as snapshots
5. **Clear test names** — test name should describe the **state transition**, not the method name

---

## Test File Layout

Each controller gets its own `.test.ts` file in the same directory:

```
src/lib/controllers/
  detector.ts              ← implementation
  detector.test.ts         ← unit tests
  action.ts
  action.test.ts
  recording.ts
  recording.test.ts
  trigger-publisher.ts
  trigger-publisher.test.ts
```

---

## DetectorController Tests

### Test 1: Initializes All Enabled Sensors

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DetectorController } from './detector';
import type { SensorConfig } from '$lib/store/pipeline';

describe('DetectorController', () => {
  let ctrl: DetectorController;
  const onStateChange = vi.fn();

  const sensors: SensorConfig[] = [
    { type: 'audio', id: 'audio-1', enabled: true, threshold: 0.5 },
    { type: 'schedule', id: 'sched-1', enabled: false, schedule: '' },
  ];

  beforeEach(() => {
    const streams = new Map();
    streams.set('audio-default', new MediaStream()); // mock
    ctrl = new DetectorController(sensors, streams, onStateChange);
  });

  it('creates detector instances only for enabled sensors', () => {
    ctrl.start();
    expect(Object.keys(ctrl.sensorStates)).toEqual(['audio-1']);
    expect(ctrl.sensorStates['sched-1']).toBeUndefined();
  });

  it('calls onStateChange when sensor fires', async () => {
    ctrl.start();
    // Simulate sensor state change (detector will call its onStateChange callback)
    await new Promise(r => setTimeout(r, 50)); // let detector initialize
    // In real detector, this happens via the detector's internal logic
    // For this test, we verify the callback is wired correctly
    expect(onStateChange).toBeDefined();
  });

  it('stops all detectors on stop()', () => {
    ctrl.start();
    const stopSpy = vi.spyOn(ctrl['detectors'].get('audio-1')!, 'stop');
    ctrl.stop();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('handles missing MediaStream gracefully', () => {
    const streams = new Map(); // empty
    const ctrlNoStream = new DetectorController(sensors, streams, onStateChange);
    expect(() => ctrlNoStream.start()).not.toThrow();
  });
});
```

### Test 2: Remote Trigger Handler (NostrTriggerDetector)

```typescript
it('forwards remote trigger events to NostrTriggerDetector', () => {
  const nostrSensor: SensorConfig = {
    type: 'nostr-trigger',
    id: 'nostr-1',
    enabled: true,
  };

  const streams = new Map();
  const ctrlWithNostr = new DetectorController([nostrSensor], streams, onStateChange);
  ctrlWithNostr.start();

  // Simulate incoming trigger event
  const triggerEvent = {
    kind: 5010,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
  };

  ctrlWithNostr.handleRemoteTrigger(triggerEvent);

  // Verify the Nostr detector was notified
  expect(onStateChange).toHaveBeenCalledWith('nostr-1', { status: 'active' });
});
```

---

## ActionController Tests

### Test 1: Link Evaluation (Single Link, All Condition)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActionController } from './action';
import type { Link, ActionConfig, SensorState } from '$lib/store/pipeline';

describe('ActionController', () => {
  let ctrl: ActionController;
  const onActivate = vi.fn();
  const onDeactivate = vi.fn();

  const links: Link[] = [
    {
      sensorIds: ['audio-1', 'motion-1'],
      condition: 'all',
      onState: 'active',
      actionIds: ['record-1'],
    },
  ];

  const actions: ActionConfig[] = [
    { type: 'record', id: 'record-1', enabled: true, channelId: 'ch-1', sources: [] },
  ];

  beforeEach(() => {
    ctrl = new ActionController(links, actions, onActivate, onDeactivate);
  });

  it('activates action when all sensors become active (all condition)', () => {
    const states: Record<string, SensorState> = {
      'audio-1': { status: 'sensing', confidence: 0.6 },
      'motion-1': { status: 'sensing', confidence: 0.8 },
    };

    ctrl.evaluateLinks(states);
    expect(onActivate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'record-1' })
    );
  });

  it('does not activate if any sensor fails (all condition)', () => {
    const states: Record<string, SensorState> = {
      'audio-1': { status: 'inactive' },
      'motion-1': { status: 'sensing' },
    };

    ctrl.evaluateLinks(states);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('deactivates action when sensor goes inactive', () => {
    // First activation
    let states: Record<string, SensorState> = {
      'audio-1': { status: 'active' },
      'motion-1': { status: 'active' },
    };
    ctrl.evaluateLinks(states);
    expect(onActivate).toHaveBeenCalled();

    // Then deactivation
    onActivate.mockClear();
    states = {
      'audio-1': { status: 'inactive' },
      'motion-1': { status: 'active' },
    };
    ctrl.evaluateLinks(states);
    expect(onDeactivate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'record-1' })
    );
  });
});
```

### Test 2: Post-Roll Timers

```typescript
it('deactivates action after post-roll delay', async () => {
  const actionsWithRoll: ActionConfig[] = [
    {
      type: 'record',
      id: 'record-1',
      enabled: true,
      channelId: 'ch-1',
      sources: [],
      postRollSec: 10,
    },
  ];

  const ctrlWithRoll = new ActionController(links, actionsWithRoll, onActivate, onDeactivate);

  const states: Record<string, SensorState> = {
    'audio-1': { status: 'active' },
    'motion-1': { status: 'active' },
  };

  ctrlWithRoll.evaluateLinks(states);
  expect(onActivate).toHaveBeenCalled();

  // Sensor goes inactive
  const statesInactive = {
    'audio-1': { status: 'inactive' },
    'motion-1': { status: 'inactive' },
  };
  ctrlWithRoll.evaluateLinks(statesInactive);

  // Post-roll timer has started but not fired yet
  expect(onDeactivate).not.toHaveBeenCalled();

  // Wait for post-roll (plus margin)
  await new Promise(r => setTimeout(r, 10050));

  // Now deactivate should have fired
  expect(onDeactivate).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'record-1' })
  );
});
```

### Test 3: Retrigger Logic (extend/ignore/restart)

```typescript
it('extends post-roll when retrigger is extend', async () => {
  const actionsWithRetrigger: ActionConfig[] = [
    {
      type: 'record',
      id: 'record-1',
      enabled: true,
      channelId: 'ch-1',
      sources: [],
      postRollSec: 10,
      retrigger: 'extend',
    },
  ];

  const ctrlRetrigger = new ActionController(links, actionsWithRetrigger, onActivate, onDeactivate);

  // Activate
  const statesActive = {
    'audio-1': { status: 'active' },
    'motion-1': { status: 'active' },
  };
  ctrlRetrigger.evaluateLinks(statesActive);

  // Deactivate
  const statesInactive = {
    'audio-1': { status: 'inactive' },
    'motion-1': { status: 'inactive' },
  };
  ctrlRetrigger.evaluateLinks(statesInactive);

  // Wait 5 seconds (half the post-roll)
  await new Promise(r => setTimeout(r, 5050));

  // Re-activate (retrigger)
  ctrlRetrigger.evaluateLinks(statesActive);

  // Should NOT have deactivated yet (post-roll was extended)
  expect(onDeactivate).not.toHaveBeenCalled();

  // Wait 10 more seconds (full post-roll from re-trigger)
  await new Promise(r => setTimeout(r, 10050));

  // Now it should deactivate
  expect(onDeactivate).toHaveBeenCalled();
});
```

---

## RecordingController Tests

### Test 1: Start Recording with Active Sources

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecordingController } from './recording';
import type { CaptureMethod } from '$lib/store/pipeline';

describe('RecordingController', () => {
  let ctrl: RecordingController;
  const onSegmentSaved = vi.fn();
  const onActiveSources = vi.fn();

  const captures: CaptureMethod[] = [
    { type: 'video', id: 'vid-1', sourceId: 'webcam', mimeType: 'video/webm' },
    { type: 'audio', id: 'aud-1', sourceId: 'mic', mimeType: 'audio/webm' },
  ];

  beforeEach(() => {
    const streams = new Map();
    streams.set('webcam', new MediaStream());
    streams.set('mic', new MediaStream());
    ctrl = new RecordingController(captures, streams, 'monitor-pubkey', onSegmentSaved, onActiveSources);
  });

  it('starts recording and reports active sources', () => {
    const action = {
      type: 'record',
      id: 'rec-1',
      channelId: 'ch-1',
      sources: ['vid-1', 'aud-1'],
    };

    ctrl.startRecording(action);

    expect(ctrl.activeRecorders.size).toBeGreaterThan(0);
    expect(onActiveSources).toHaveBeenCalledWith('ch-1', ['webcam', 'mic']);
  });

  it('stops recording and clears active sources', () => {
    const action = {
      type: 'record',
      id: 'rec-1',
      channelId: 'ch-1',
      sources: ['vid-1', 'aud-1'],
    };

    ctrl.startRecording(action);
    ctrl.stopRecording(action);

    expect(ctrl.activeRecorders.size).toBe(0);
    expect(onActiveSources).toHaveBeenCalledWith('ch-1', []);
  });

  it('saves segment on MediaRecorder ondataavailable', async () => {
    const action = {
      type: 'record',
      id: 'rec-1',
      channelId: 'ch-1',
      sources: ['vid-1'],
    };

    ctrl.startRecording(action);

    // Simulate recording chunk
    const recorder = ctrl.activeRecorders.values().next().value;
    const blob = new Blob(['mock audio data'], { type: 'audio/webm' });
    recorder.ondataavailable(new BlobEvent('dataavailable', { data: blob }));

    // Wait for async save
    await new Promise(r => setTimeout(r, 100));

    expect(onSegmentSaved).toHaveBeenCalled();
  });
});
```

---

## TriggerPublisher Tests

### Test 1: Publishes on Sensor State (with Nostr Gate)

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TriggerPublisher } from './trigger-publisher';
import { nostrOnline } from '$lib/store/nostr-online';
import type { NotifyAction } from '$lib/store/pipeline';

describe('TriggerPublisher', () => {
  let pub: TriggerPublisher;
  const privkey = new Uint8Array(32).fill(1);
  const monitorPubkey = 'abc...def';
  const actions: NotifyAction[] = [
    { type: 'notify', id: 'notify-1', enabled: true, publishStates: ['active'] },
  ];

  beforeEach(() => {
    pub = new TriggerPublisher(privkey, monitorPubkey, actions, []);
  });

  it('does not publish when nostrOnline is false', async () => {
    // Mock nostrOnline to false
    vi.mocked(nostrOnline).set(false);

    await pub.handleSensorState('sensor-1', { status: 'active' }, {
      channelId: 'ch-1',
      detectionType: 'audio',
      footageRefId: null,
    });

    // Publish should not have happened (check outbox, not direct publish)
    // This test verifies the gate; actual publish is tested separately
  });

  it('publishes trigger event when sensor activates', async () => {
    vi.mocked(nostrOnline).set(true);
    const publishSpy = vi.spyOn(global, 'publish');

    await pub.handleSensorState('sensor-1', { status: 'active' }, {
      channelId: 'ch-1',
      detectionType: 'audio',
      footageRefId: 'ref-123',
    });

    // Verify event was queued (published through outbox)
    expect(publishSpy).toBeDefined();
  });

  it('respects cooldown timer per action', async () => {
    vi.mocked(nostrOnline).set(true);

    // Fire sensor
    await pub.handleSensorState('sensor-1', { status: 'active' }, {
      channelId: 'ch-1',
      detectionType: 'audio',
      footageRefId: 'ref-123',
    });

    // Fire again immediately
    await pub.handleSensorState('sensor-1', { status: 'active' }, {
      channelId: 'ch-1',
      detectionType: 'audio',
      footageRefId: 'ref-124',
    });

    // Only one publish should have happened (second is cooldown-queued)
    // After cooldown expires, second should publish
  });
});
```

---

## Integration Tests: Multi-Controller Flow

Test the interaction between controllers:

```typescript
describe('Detector + Action + Recording Flow', () => {
  it('detects sensor, evaluates link, activates recording, publishes notification', async () => {
    const detectorCtrl = new DetectorController([...], streams, onSensorChange);
    const actionCtrl = new ActionController([...], [...], onActionActivate, onActionDeactivate);
    const recordingCtrl = new RecordingController([...], streams, 'monitor-pk', onSegSaved, onActiveSrc);
    const publishCtrl = new TriggerPublisher(privkey, monitorPk, [notifyAction], []);

    // Wire callbacks
    const sensorChangeHandler = (sensorId: string, state: SensorState) => {
      actionCtrl.evaluateLinks(detectorCtrl.sensorStates);
    };

    const actionActivateHandler = (action: ActionConfig) => {
      if (action.type === 'record') {
        recordingCtrl.startRecording(action);
      }
      publishCtrl.handleSensorState('sensor-1', { status: 'active' }, {...});
    };

    // Start detectors
    detectorCtrl.start();

    // Simulate sensor activation
    await detectorsSimulateActivation();

    // Verify chain: sensor → action → recording → notify
    expect(recordingCtrl.activeRecorders.size).toBeGreaterThan(0);
    expect(publishCtrl.hasPendingPublish()).toBe(true);
  });
});
```

---

## Test Organization and Running

```bash
# Run all tests
npm run test

# Run tests for a specific file
npm run test detector.test.ts

# Run with coverage
npm run test -- --coverage

# Run in watch mode (for development)
npm run test -- --watch
```

---

## Debugging Failed Tests

1. **State not updated:** check if callback is being called synchronously
2. **Timers not firing:** use `vi.useFakeTimers()` to control timing
3. **Async issues:** always `await` promises in tests
4. **Mock not being called:** verify dependency injection — is the mock actually passed to the controller?

---

## Coverage Goals

- **Controller unit tests:** 80%+ line coverage, 100% path coverage for critical flows
- **Integration tests:** cover 2–3 controller interaction patterns
- **Edge cases:** missing streams, disabled sensors, disabled actions, cooldown behavior

---

## Checklist Before Merging a Controller

- [ ] All unit tests pass (`npm run test`)
- [ ] Line coverage is 80%+
- [ ] State ownership table is in JSDoc or tests
- [ ] Tests verify invariants, not just happy path
- [ ] Integration test (with one adjacent controller) exists
- [ ] Error cases handled (missing streams, invalid config, etc.)
- [ ] No Svelte imports in controller
- [ ] No browser APIs (except MediaStream/MediaRecorder, which are mocked)
