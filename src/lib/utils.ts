/**
 * Shared utility functions used across components.
 */

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

interface FilePickerOptions {
	accept?: string;
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
