import type { BiosFileDefinition } from './definitions.js';

/**
 * Compute SHA-1 hash of data using the Web Crypto API.
 */
export async function sha1(data: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-1', data as unknown as BufferSource);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
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
	data: Uint8Array,
	definition: BiosFileDefinition
): Promise<BiosValidationResult> {
	const actualSha1 = await sha1(data);
	return {
		valid: actualSha1 === definition.sha1,
		actualSha1,
		expectedSha1: definition.sha1
	};
}
