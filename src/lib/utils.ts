/**
 * Shared utility functions used across components.
 */

/** Typed notification state — replaces overloaded `error: string` pattern. */
export interface Notification {
	type: 'error' | 'success';
	message: string;
}

export function errorMsg(message: string): Notification {
	return { type: 'error', message };
}

export function successMsg(message: string): Notification {
	return { type: 'success', message };
}

/**
 * Format a byte size into a human-readable string.
 * Accepts both bigint (from ADB lstat) and number.
 */
export function formatSize(size: bigint | number): string {
	const n = typeof size === 'bigint' ? Number(size) : size;
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Extract a human-readable message from an unknown error value.
 */
export function formatError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Join a base path with a filename, avoiding double slashes at root.
 */
export function joinPath(base: string, name: string): string {
	return base === '/' ? '/' + name : base + '/' + name;
}

/**
 * Locale-aware case-insensitive comparator for sorting objects by `name`.
 */
export function compareByName<T extends { name: string }>(a: T, b: T): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Simple English pluralization: `plural(3, 'file')` → `'3 files'`.
 */
export function plural(count: number, word: string): string {
	return `${count} ${word}${count !== 1 ? 's' : ''}`;
}

/**
 * Get the MIME type for an image filename based on its extension.
 */
export function getMimeType(name: string): string {
	const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
	const mimeMap: Record<string, string> = {
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.jpeg': 'image/jpeg',
		'.bmp': 'image/bmp',
		'.gif': 'image/gif',
		'.webp': 'image/webp',
		'.svg': 'image/svg+xml'
	};
	return mimeMap[ext] || 'image/png';
}

interface FilePickerOptions {
	accept?: string;
}

export interface DroppedFile {
	file: File;
	relativePath: string;
}

function readDroppedEntries(entry: FileSystemEntry, basePath = ''): Promise<DroppedFile[]> {
	if (entry.isFile) {
		return new Promise((resolve, reject) => {
			(entry as FileSystemFileEntry).file(
				(file) => resolve([{ file, relativePath: basePath + file.name }]),
				reject
			);
		});
	}

	const reader = (entry as FileSystemDirectoryEntry).createReader();
	return new Promise((resolve, reject) => {
		const allEntries: FileSystemEntry[] = [];
		const readBatch = () => {
			reader.readEntries((batch) => {
				if (batch.length === 0) {
					Promise.all(
						allEntries.map((child) => readDroppedEntries(child, basePath + entry.name + '/'))
					).then((results) => resolve(results.flat()), reject);
				} else {
					allEntries.push(...batch);
					readBatch();
				}
			}, reject);
		};
		readBatch();
	});
}

export function hasDraggedFiles(event: DragEvent): boolean {
	const items = event.dataTransfer?.items;
	if (items) {
		return Array.from(items).some((item) => item.kind === 'file');
	}
	return (event.dataTransfer?.files.length ?? 0) > 0;
}

export async function getDroppedFiles(event: DragEvent): Promise<DroppedFile[]> {
	const items = Array.from(event.dataTransfer?.items ?? []).filter((item) => item.kind === 'file');
	const fsEntries = items
		.map((item) => item.webkitGetAsEntry?.() ?? null)
		.filter((entry): entry is FileSystemEntry => entry !== null);

	if (fsEntries.length > 0) {
		return (await Promise.all(fsEntries.map((entry) => readDroppedEntries(entry)))).flat();
	}

	return Array.from(event.dataTransfer?.files ?? []).map((file) => ({
		file,
		relativePath: file.name
	}));
}

/**
 * Open a file picker dialog and return the selected files.
 * Returns an empty array if the user cancels.
 */
export function pickFiles(options?: FilePickerOptions): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		if (options?.accept) input.accept = options.accept;
		input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
		input.oncancel = () => resolve([]);
		input.click();
	});
}

/**
 * Open a file picker dialog for a single file.
 * Returns null if the user cancels.
 */
export function pickFile(options?: FilePickerOptions): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		if (options?.accept) input.accept = options.accept;
		input.onchange = () => resolve(input.files?.[0] ?? null);
		input.oncancel = () => resolve(null);
		input.click();
	});
}

/**
 * Open a directory picker dialog. Returns all files within the selected folder,
 * each with `webkitRelativePath` set (e.g. "FolderName/sub/file.txt").
 * Returns an empty array if the user cancels.
 */
export function pickDirectory(): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.webkitdirectory = true;
		input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
		input.oncancel = () => resolve([]);
		input.click();
	});
}
