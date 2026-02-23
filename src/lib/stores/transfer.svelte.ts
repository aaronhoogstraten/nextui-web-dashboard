import type { Adb } from '@yume-chan/adb';
import { pushFile, pullFile } from '$lib/adb/file-ops.js';

export type TransferDirection = 'upload' | 'download';

/** How long (ms) the bar lingers at 100% after completion */
const LINGER_MS = 500;

// --- Reactive state ---
let active: boolean = $state(false);
let direction: TransferDirection = $state('upload');
let currentFileName: string = $state('');
let filesCompleted: number = $state(0);
let filesTotal: number = $state(0);
let bytesTransferred: number = $state(0);
let bytesTotal: number = $state(0);
let lingerTimer: ReturnType<typeof setTimeout> | null = null;

// Tracks cumulative bytes from previous files in the batch
let fileBaseBytes = 0;

// --- Getters ---
export function isTransferActive(): boolean {
	return active;
}
export function getTransferDirection(): TransferDirection {
	return direction;
}
export function getCurrentFileName(): string {
	return currentFileName;
}
export function getFilesCompleted(): number {
	return filesCompleted;
}
export function getFilesTotal(): number {
	return filesTotal;
}
export function getBytesTransferred(): number {
	return bytesTransferred;
}
export function getBytesTotal(): number {
	return bytesTotal;
}

// --- Lifecycle ---

export function beginTransfer(dir: TransferDirection, totalFiles: number, totalBytes?: number): void {
	if (lingerTimer) {
		clearTimeout(lingerTimer);
		lingerTimer = null;
	}
	active = true;
	direction = dir;
	filesCompleted = 0;
	filesTotal = totalFiles;
	bytesTransferred = 0;
	bytesTotal = totalBytes ?? 0;
	currentFileName = '';
	fileBaseBytes = 0;
}

export function endTransfer(): void {
	if (!active) return;
	// Snap to 100% then linger before hiding
	filesCompleted = filesTotal;
	if (bytesTotal > 0) bytesTransferred = bytesTotal;
	lingerTimer = setTimeout(() => {
		active = false;
		currentFileName = '';
		lingerTimer = null;
	}, LINGER_MS);
}

/** Adjust filesTotal down when a file is skipped/filtered during a batch. */
export function skipTransferFile(fileBytes?: number): void {
	if (filesTotal > 0) filesTotal--;
	if (fileBytes && bytesTotal > 0) bytesTotal -= fileBytes;
}

// --- Internal progress handler ---

function onFileProgress(bytes: number, _total: number): void {
	bytesTransferred = fileBaseBytes + bytes;
}

// --- Tracked wrappers ---

export async function trackedPush(
	adb: Adb,
	remotePath: string,
	content: Uint8Array,
	permission = 0o644
): Promise<void> {
	currentFileName = remotePath.split('/').pop() ?? remotePath;
	fileBaseBytes = bytesTransferred;
	await pushFile(adb, remotePath, content, permission, onFileProgress);
	filesCompleted++;
}

export async function trackedPull(
	adb: Adb,
	remotePath: string
): Promise<Uint8Array<ArrayBuffer>> {
	currentFileName = remotePath.split('/').pop() ?? remotePath;
	fileBaseBytes = bytesTransferred;
	const result = await pullFile(adb, remotePath, onFileProgress);
	filesCompleted++;
	return result;
}
