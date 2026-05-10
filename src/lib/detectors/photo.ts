import { saveSegment } from '$lib/db/segments';
import { dbg } from '$lib/store/debug';

export interface PhotoCaptureConfig {
	snapshotCount: number;
	intervalSec: number;
	imageWidth: number;
	imageHeight: number;   // 0 = proportional to width (auto aspect ratio)
	imageQuality: number;  // 0.0–1.0
	imageFormat?: string;
}

// Captures snapshotCount JPEG frames from a video stream, separated by intervalSec.
// Returns an array of photo IDs stored in IndexedDB.
export async function capturePhotosOnTrigger(
	stream: MediaStream,
	config: PhotoCaptureConfig,
	originMonitor: string,
	triggerTime: number,
	sourceId = 'default-cam'
): Promise<string[]> {
	const videoTrack = stream.getVideoTracks()[0];
	if (!videoTrack) {
		dbg('warn', 'detector', 'capturePhotos: no video track available');
		return [];
	}

	const photoIds: string[] = [];
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	if (!ctx) return [];

	// Try ImageCapture API first (gives higher quality frames).
	// If grabFrame() fails (e.g. screen capture tracks), fall back to canvas-from-video-element
	// for all remaining snapshots. useCanvas switches to true on the first failure.
	let useCanvas = typeof ImageCapture === 'undefined';

	if (!useCanvas) {
		const imageCapture = new ImageCapture(videoTrack);
		for (let i = 0; i < config.snapshotCount; i++) {
			let bitmap: ImageBitmap | undefined;
			try {
				bitmap = await imageCapture.grabFrame();
			} catch (err) {
				dbg('warn', 'detector', `ImageCapture.grabFrame failed, falling back to canvas: ${err}`);
				useCanvas = true;
				break;
			}
			const width = config.imageWidth > 0 ? config.imageWidth : bitmap.width;
			const height = config.imageHeight > 0 ? config.imageHeight : Math.round(bitmap.height * (width / bitmap.width));
			canvas.width = width;
			canvas.height = height;
			ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const blob = await canvasToBlob(canvas, config.imageFormat ?? 'image/jpeg', config.imageQuality);
			if (blob) {
				const capturedAt = triggerTime + i * config.intervalSec;
				const id = await saveSegment(blob, config.imageFormat ?? 'image/jpeg', capturedAt, capturedAt + 1, originMonitor, sourceId);
				photoIds.push(id);
				dbg('info', 'detector', `photo captured: ${id} (${blob.size} bytes)`);
			}
			if (i < config.snapshotCount - 1) {
				await sleep(config.intervalSec * 1000);
			}
		}
	}

	// Canvas fallback — covers all snapshots when ImageCapture is absent, or remaining
	// ones when grabFrame() failed partway through (photoIds.length = snapshots already done).
	if (useCanvas) {
		const startIdx = photoIds.length;
		const video = document.createElement('video');
		video.srcObject = stream;
		video.muted = true;
		await video.play();

		for (let i = startIdx; i < config.snapshotCount; i++) {
			const width = config.imageWidth > 0 ? config.imageWidth : video.videoWidth;
			const height = config.imageHeight > 0 ? config.imageHeight : Math.round(video.videoHeight * (width / video.videoWidth));
			canvas.width = width;
			canvas.height = height;
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			const blob = await canvasToBlob(canvas, config.imageFormat ?? 'image/jpeg', config.imageQuality);
			if (blob) {
				const capturedAt = triggerTime + i * config.intervalSec;
				const id = await saveSegment(blob, config.imageFormat ?? 'image/jpeg', capturedAt, capturedAt + 1, originMonitor, sourceId);
				photoIds.push(id);
			}
			if (i < config.snapshotCount - 1) {
				await sleep(config.intervalSec * 1000);
			}
		}

		video.pause();
		video.srcObject = null;
	}

	return photoIds;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
