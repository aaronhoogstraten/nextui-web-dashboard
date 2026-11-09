import type { Adb } from '@yume-chan/adb';
import type { FileVersion } from '$lib/adb/types.js';
import type { BiosFileDefinition } from './definitions.js';

/**
 * Compute SHA-1 hash of data using the Web Crypto API.
 */
export async function sha1(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-1', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface CachedBiosHash extends FileVersion {
	sha1: string;
}

/**
 * SHA-1s of BIOS files already read from the device, by device path, so that
 * reopening the BIOS view doesn't pull every file again. Each connection has
 * its own `Adb`, so a reconnect (or another device or card) starts empty.
 */
const biosHashCache = new WeakMap<Adb, Map<string, CachedBiosHash>>();

/** Get a file's known SHA-1, or null if it was never read or has since changed. */
export function getCachedBiosHash(adb: Adb, path: string, version: FileVersion): string | null {
	const cached = biosHashCache.get(adb)?.get(path);
	if (!cached || cached.size !== version.size || cached.mtime !== version.mtime) return null;
	return cached.sha1;
}

export function cacheBiosHash(adb: Adb, path: string, version: FileVersion, sha1: string): void {
	// An mtime of 0 means the device didn't report one, leaving only the size to
	// detect a replaced file, which isn't enough to trust the hash later.
	if (version.mtime === 0n) return;
	let hashes = biosHashCache.get(adb);
	if (!hashes) {
		hashes = new Map();
		biosHashCache.set(adb, hashes);
	}
	hashes.set(path, { ...version, sha1 });
}

/** Drop a file's known SHA-1, for when the app itself is about to rewrite it. */
export function forgetBiosHash(adb: Adb, path: string): void {
	biosHashCache.get(adb)?.delete(path);
}

/** Result of validating a BIOS file */
export interface BiosValidationResult {
	/** Whether the file hash matches the expected value */
	valid: boolean;
	/** The actual SHA-1 hash computed from the file */
	actualSha1: string;
	/** The expected SHA-1 hash from the definition */
	expectedSha1: string;
}

/**
 * Validate a BIOS file against its expected SHA-1 checksum.
 *
 * The original app validates against either MD5 or SHA-1. Since Web Crypto
 * supports SHA-1 natively but not MD5, we use SHA-1 for validation.
 *
 * @param data - File content as Uint8Array
 * @param definition - The BIOS file definition with expected hashes
 * @returns Validation result with match status and computed hash
 */
export async function validateBiosFile(
	data: Uint8Array<ArrayBuffer>,
	definition: BiosFileDefinition
): Promise<BiosValidationResult> {
	const actualSha1 = await sha1(data);
	return {
		valid: actualSha1 === definition.sha1,
		actualSha1,
		expectedSha1: definition.sha1
	};
}
