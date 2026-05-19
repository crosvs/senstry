import { writable } from 'svelte/store';
import type { SensorState, ActionState } from './pipeline';

export const sensorStates = writable<Record<string, SensorState>>({});
export const actionStates = writable<Record<string, ActionState>>({});
