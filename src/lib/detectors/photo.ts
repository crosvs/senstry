import { savePhoto } from '$lib/db/photos';
import { dbg } from '$lib/store/debug';

export interface PhotoCaptureConfig {
	snapshotCount: number;
	intervalSec: number;
	imageWidth: number;
	imageQuality: number;  // 0.0–1.0
}

// Captures snapshotCount JPEG frames from a video stream, separated by intervalSec.
// Returns an array of photo IDs stored in IndexedDB.
export async function capturePhotosOnTrigger(
	stream: MediaStream,
	config: PhotoCaptureConfig,
	originMonitor: string,
	triggerTime: number
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

	// Try ImageCapture API first (gives higher quality frames)
	// Fall back to canvas-from-video-element if unavailable
	const useImageCapture = typeof ImageCapture !== 'undefined';

	if (useImageCapture) {
		const imageCapture = new ImageCapture(videoTrack);
		for (let i = 0; i < config.snapshotCount; i++) {
			try {
				const bitmap = await imageCapture.grabFrame();
				const width = config.imageWidth > 0 ? config.imageWidth : bitmap.width;
				const scale = width / bitmap.width;
				canvas.width = width;
				canvas.height = Math.round(bitmap.height * scale);
				ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				const blob = await canvasToBlob(canvas, 'image/jpeg', config.imageQuality);
				if (blob) {
					const capturedAt = triggerTime + i * config.intervalSec;
					const id = await savePhoto(blob, 'image/jpeg', canvas.width, canvas.height, capturedAt, originMonitor);
					photoIds.push(id);
					dbg('info', 'detector', `photo captured: ${id} (${blob.size} bytes)`);
				}
			} catch (err) {
				dbg('warn', 'detector', `photo capture failed: ${err}`);
			}
			if (i < config.snapshotCount - 1) {
				await sleep(config.intervalSec * 1000);
			}
		}
	} else {
		// Fallback: render video to canvas
		const video = document.createElement('video');
		video.srcObject = stream;
		video.muted = true;
		await video.play();

		for (let i = 0; i < config.snapshotCount; i++) {
			const width = config.imageWidth > 0 ? config.imageWidth : video.videoWidth;
			const scale = width / video.videoWidth;
			canvas.width = width;
			canvas.height = Math.round(video.videoHeight * scale);
			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			const blob = await canvasToBlob(canvas, 'image/jpeg', config.imageQuality);
			if (blob) {
				const capturedAt = triggerTime + i * config.intervalSec;
				const id = await savePhoto(blob, 'image/jpeg', canvas.width, canvas.height, capturedAt, originMonitor);
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
