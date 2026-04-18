export interface DetectionEvent<T = Record<string, unknown>> {
	type: string;
	data: T;
	timestamp: number;
}

export interface Detector<T = Record<string, unknown>> {
	start(stream: MediaStream): void;
	stop(): void;
	onDetection: ((event: DetectionEvent<T>) => void) | null;
}

export interface AudioDetectionData {
	peakDb: number;
	durationMs: number;
}
