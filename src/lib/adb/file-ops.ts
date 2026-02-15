import type { Adb } from '@yume-chan/adb';
import { LinuxFileType } from '@yume-chan/adb';
import type { MaybeConsumable } from '@yume-chan/stream-extra';
import JSZip from 'jszip';
import type { DirectoryEntry, StorageInfo } from './types.js';
import { DEVICE_PATHS } from './types.js';
import { adbLog } from '$lib/stores/log.svelte.js';
import { formatError } from '$lib/utils.js';
import { ShellCmd } from './adb-utils.js';

/** Path inside MinUI.zip that distinguishes NextUI from other MinUI forks */
const NEXTUI_SYSTEM_TXT = '.system/system.txt';

/**
 * Push a file to the device.
 *
 * @param adb - Active ADB connection
 * @param remotePath - Destination path on device
 * @param content - File content as Uint8Array
 * @param permission - Unix file permission (default: 0o644)
 */
export async function pushFile(
	adb: Adb,
	remotePath: string,
	content: Uint8Array,
	permission = 0o644
): Promise<void> {
	adbLog.info(`sync.write → ${remotePath} (${content.byteLength} bytes, perm=${permission.toString(8)})`);
	const sync = await adb.sync();
	try {
		const stream = new ReadableStream<MaybeConsumable<Uint8Array>>({
			start(controller) {
				controller.enqueue(content);
				controller.close();
			}
		});

		await sync.write({
			filename: remotePath,
			// Cast needed: browser ReadableStream lacks async iterator that ya-webadb's type expects
			file: stream as never,
			permission
		});
		adbLog.info(`sync.write ✓ ${remotePath}`);
	} catch (e) {
		adbLog.error(`sync.write ✗ ${remotePath}: ${e}`);
		throw e;
	} finally {
		await sync.dispose();
	}
}

/**
 * Pull a file from the device and return its content.
 *
 * @param adb - Active ADB connection
 * @param remotePath - Path to the file on the device
 * @returns File content as Uint8Array
 */
export async function pullFile(adb: Adb, remotePath: string): Promise<Uint8Array<ArrayBuffer>> {
	adbLog.info(`sync.read → ${remotePath}`);
	const sync = await adb.sync();
	try {
		const stream = sync.read(remotePath);
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let totalLength = 0;

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalLength += value.byteLength;
		}

		// Concatenate all chunks
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}

		adbLog.info(`sync.read ✓ ${remotePath} (${totalLength} bytes)`);
		return result;
	} catch (e) {
		adbLog.error(`sync.read ✗ ${remotePath}: ${e}`);
		throw e;
	} finally {
		await sync.dispose();
	}
}

/**
 * List the contents of a directory on the device.
 *
 * @param adb - Active ADB connection
 * @param remotePath - Directory path on the device
 * @returns Array of directory entries
 */
export async function listDirectory(adb: Adb, remotePath: string): Promise<DirectoryEntry[]> {
	adbLog.debug(`sync.opendir → ${remotePath}`);
	const sync = await adb.sync();
	try {
		const entries: DirectoryEntry[] = [];
		for await (const entry of sync.opendir(remotePath)) {
			// Skip . and .. entries
			if (entry.name === '.' || entry.name === '..') continue;

			entries.push({
				name: entry.name,
				size: entry.size,
				isDirectory: entry.type === LinuxFileType.Directory,
				isFile: entry.type === LinuxFileType.File,
				mtime: entry.mtime
			});
		}
		adbLog.debug(`sync.opendir ✓ ${remotePath} (${entries.length} entries)`);
		return entries;
	} catch (e) {
		adbLog.error(`sync.opendir ✗ ${remotePath}: ${e}`);
		throw e;
	} finally {
		await sync.dispose();
	}
}

/**
 * Check if a path exists on the device.
 * Uses lstat (works on NextUI devices) instead of stat (which does not).
 *
 * @param adb - Active ADB connection
 * @param remotePath - Path to check
 * @returns true if the path exists
 */
export async function pathExists(adb: Adb, remotePath: string): Promise<boolean> {
	const sync = await adb.sync(); // Let transport errors propagate
	try {
		const st = await sync.lstat(remotePath);
		return st.mode !== 0;
	} catch {
		return false;
	} finally {
		await sync.dispose();
	}
}

/**
 * Check if a path is a directory on the device.
 * Uses lstat (works on NextUI devices) instead of stat.
 */
export async function isDirectory(adb: Adb, remotePath: string): Promise<boolean> {
	const sync = await adb.sync(); // Let transport errors propagate
	try {
		const st = await sync.lstat(remotePath);
		return (st.mode & 0o170000) === 0o040000; // S_IFDIR
	} catch {
		return false;
	} finally {
		await sync.dispose();
	}
}

/**
 * Run a shell command on the device and return stdout.
 * Uses raw shell socket (createSocketAndWait) which works on NextUI's
 * minimal ADB daemon. The subprocess service is not supported on these devices.
 *
 * @param adb - Active ADB connection
 * @param command - Shell command to execute
 * @returns Command stdout
 */
export async function shell(adb: Adb, command: string): Promise<string> {
	adbLog.info(`shell → ${command}`);
	try {
		const result = await adb.createSocketAndWait(`shell:${command}`);
		adbLog.info(`shell ✓ ${command} (${result.length} chars)`);
		return result;
	} catch (e) {
		adbLog.error(`shell ✗ ${command}: ${e}`);
		throw e;
	}
}

/**
 * Search for files/directories by name pattern (case-insensitive).
 * Uses BusyBox `find` via shell.
 *
 * @param adb - Active ADB connection
 * @param basePath - Directory to search from
 * @param query - Search term (matched anywhere in filename)
 * @param maxResults - Maximum number of results to return (default 200)
 * @returns Array of absolute paths
 */
export async function searchFiles(
	adb: Adb,
	basePath: string,
	query: string,
	maxResults = 200
): Promise<string[]> {
	const pattern = `*${query}*`;
	const output = await shell(adb, ShellCmd.find(basePath, pattern).toString());
	return output.trim().split('\n').filter(Boolean).slice(0, maxResults);
}

/**
 * Get storage information for the SD card.
 *
 * @param adb - Active ADB connection
 * @returns Storage info or null if unavailable
 */
export async function getStorageInfo(adb: Adb): Promise<StorageInfo | null> {
	try {
		const output = await shell(adb, ShellCmd.df(DEVICE_PATHS.base).toString());
		const lines = output.trim().split('\n');
		if (lines.length < 2) return null;

		// Parse header to find column indices (handles BusyBox and GNU df variants)
		const header = lines[0].split(/\s+/);
		const colTotal = header.findIndex((h) => /1k-blocks|1024-blocks|size/i.test(h));
		const colUsed = header.findIndex((h) => /^used$/i.test(h));
		const colAvail = header.findIndex((h) => /^avail/i.test(h));

		if (colTotal < 0 || colUsed < 0 || colAvail < 0) {
			// Fallback to positional if headers don't match
			const parts = lines[lines.length - 1].split(/\s+/);
			if (parts.length < 4) return null;
			const t = parseInt(parts[1], 10), u = parseInt(parts[2], 10), a = parseInt(parts[3], 10);
			if (isNaN(t) || isNaN(u) || isNaN(a)) return null;
			return { totalBytes: t * 1024, usedBytes: u * 1024, availableBytes: a * 1024 };
		}

		const parts = lines[lines.length - 1].split(/\s+/);
		const totalKb = parseInt(parts[colTotal], 10);
		const usedKb = parseInt(parts[colUsed], 10);
		const availableKb = parseInt(parts[colAvail], 10);

		if (isNaN(totalKb) || isNaN(usedKb) || isNaN(availableKb)) return null;

		return {
			totalBytes: totalKb * 1024,
			usedBytes: usedKb * 1024,
			availableBytes: availableKb * 1024
		};
	} catch {
		return null;
	}
}

/**
 * Verify that a NextUI installation exists on the connected device.
 * Checks for the base path, Bios directory, Roms directory, and version file.
 *
 * @param adb - Active ADB connection
 * @returns Object with success status and error message if failed
 */
export interface VerifyResult {
	ok: boolean;
	error?: string;
	version?: string;
}

export async function verifyNextUIInstallation(
	adb: Adb
): Promise<VerifyResult> {
	// Check base path by listing /mnt and looking for SDCARD
	if (!(await pathExists(adb, DEVICE_PATHS.base))) {
		return { ok: false, error: `NextUI installation not found at ${DEVICE_PATHS.base}` };
	}

	// Check Bios and Roms directories
	if (!(await pathExists(adb, DEVICE_PATHS.bios))) {
		return { ok: false, error: `BIOS directory not found at ${DEVICE_PATHS.bios}` };
	}
	if (!(await pathExists(adb, DEVICE_PATHS.roms))) {
		return { ok: false, error: `ROMs directory not found at ${DEVICE_PATHS.roms}` };
	}

	// Check for version indicator (MinUI.zip or .system/version.txt)
	const hasMinUI = await pathExists(adb, DEVICE_PATHS.minuiZip);
	const hasVersionFile = await pathExists(adb, DEVICE_PATHS.versionFile);

	if (!hasMinUI && !hasVersionFile) {
		return {
			ok: false,
			error: 'NextUI version file not found. Please ensure NextUI is properly installed.'
		};
	}

	// Verify MinUI.zip contains system.txt to distinguish NextUI from other MinUI forks
	if (hasMinUI) {
		try {
			adbLog.info(`Verifying MinUI.zip contains ${NEXTUI_SYSTEM_TXT}...`);
			const zipData = await pullFile(adb, DEVICE_PATHS.minuiZip);
			const zip = await JSZip.loadAsync(zipData);
			const systemTxt = zip.file(NEXTUI_SYSTEM_TXT);
			if (!systemTxt) {
				return {
					ok: false,
					error: 'This device appears to be running a non-NextUI fork of MinUI. The dashboard only supports NextUI.'
				};
			}
			const version = (await systemTxt.async('string')).trim();
			adbLog.info(`MinUI.zip verified: ${NEXTUI_SYSTEM_TXT} found (version: ${version})`);
			return { ok: true, version };
		} catch (e) {
			adbLog.error(`Failed to verify MinUI.zip contents: ${e}`);
			return {
				ok: false,
				error: `Failed to verify MinUI.zip: ${formatError(e)}`
			};
		}
	}

	// No MinUI.zip but version.txt exists — read version from it
	if (hasVersionFile) {
		try {
			const versionData = await pullFile(adb, DEVICE_PATHS.versionFile);
			const version = new TextDecoder().decode(versionData).trim();
			adbLog.info(`Version from version.txt: ${version}`);
			return { ok: true, version };
		} catch (e) {
			adbLog.warn(`Could not read version.txt: ${e}`);
		}
	}

	return { ok: true };
}

/**
 * Run a full diagnostic check against the connected device.
 * Tests all available APIs and returns detailed results for debugging.
 */
export async function runDiagnostics(
	adb: Adb
): Promise<{ label: string; status: 'ok' | 'fail' | 'skip'; detail: string }[]> {
	type DiagResult = { label: string; status: 'ok' | 'fail' | 'skip'; detail: string };

	async function test(label: string, fn: () => Promise<DiagResult['detail']>): Promise<DiagResult> {
		try {
			return { label, status: 'ok', detail: await fn() };
		} catch (e) {
			return { label, status: 'fail', detail: String(e) };
		}
	}

	const results: DiagResult[] = [];

	results.push(await test('ADB Transport', async () =>
		`serial=${adb.serial}, maxPayload=${adb.maxPayloadSize}, features=[${adb.banner.features?.join(', ') ?? 'none'}]`
	));

	results.push(await test('sync.opendir("/")', async () => {
		const entries = await listDirectory(adb, '/');
		return `${entries.length} entries: ${entries.map((e) => e.name).join(', ')}`;
	}));

	results.push(await test(`sync.opendir("${DEVICE_PATHS.base}")`, async () => {
		const entries = await listDirectory(adb, DEVICE_PATHS.base);
		const dirs = entries.filter((e) => e.isDirectory).map((e) => e.name);
		return `${entries.length} entries. Dirs: ${dirs.join(', ')}`;
	}));

	results.push(await test(`sync.stat("${DEVICE_PATHS.base}")`, async () => {
		const sync = await adb.sync();
		try {
			const st = await sync.stat(DEVICE_PATHS.base);
			return `mode=${st.mode}, size=${st.size}`;
		} finally {
			await sync.dispose();
		}
	}));

	results.push(await test(`sync.lstat("${DEVICE_PATHS.base}")`, async () => {
		const sync = await adb.sync();
		try {
			const st = await sync.lstat(DEVICE_PATHS.base);
			return `mode=${st.mode}, size=${st.size}`;
		} finally {
			await sync.dispose();
		}
	}));

	results.push(await test('sync.read("README.txt")', async () => {
		const content = await pullFile(adb, `${DEVICE_PATHS.base}/README.txt`);
		const text = new TextDecoder().decode(content.slice(0, 200));
		return `${content.byteLength} bytes. Start: ${text.substring(0, 80).replace(/\n/g, '\\n')}...`;
	}));

	results.push(await test('subprocess.noneProtocol', async () => {
		const output = await adb.subprocess.noneProtocol.spawnWaitText('echo hello');
		return `output="${output.trim()}"`;
	}));

	// shellProtocol — may not be available
	try {
		const proto = adb.subprocess.shellProtocol;
		if (proto) {
			results.push(await test('subprocess.shellProtocol', async () => {
				const result = await proto.spawnWaitText('echo hello');
				return `stdout="${result.stdout.trim()}", exitCode=${result.exitCode}`;
			}));
		} else {
			results.push({ label: 'subprocess.shellProtocol', status: 'skip', detail: 'Not available (shellProtocol is undefined)' });
		}
	} catch (e) {
		results.push({ label: 'subprocess.shellProtocol', status: 'fail', detail: String(e) });
	}

	results.push(await test('createSocketAndWait("shell:...")', async () => {
		const output = await adb.createSocketAndWait('shell:echo hello');
		return `output="${output.trim()}"`;
	}));

	results.push(await test('verifyNextUIInstallation', async () => {
		const result = await verifyNextUIInstallation(adb);
		if (!result.ok) throw new Error(result.error ?? 'Unknown error');
		return 'Verified';
	}));

	results.push(await test('getStorageInfo', async () => {
		const info = await getStorageInfo(adb);
		if (!info) throw new Error('Returned null (shell may not be supported)');
		const toGB = (b: number) => (b / 1024 / 1024 / 1024).toFixed(2);
		return `${toGB(info.usedBytes)} GB / ${toGB(info.totalBytes)} GB (${toGB(info.availableBytes)} GB free)`;
	}));

	return results;
}
