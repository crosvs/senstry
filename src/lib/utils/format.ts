export function formatDetectionType(type: string): string {
	const labels: Record<string, string> = {
		audio: 'Audio Detected',
		motion: 'Motion Detected',
		camera: 'Camera Event',
		gyroscope: 'Device Moved',
		recognition: 'Object Detected'
	};
	return labels[type] ?? type;
}

export function formatDb(db: number): string {
	return `${db > 0 ? '+' : ''}${db.toFixed(1)} dBFS`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}
