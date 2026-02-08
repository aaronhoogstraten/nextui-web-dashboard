import type { Adb } from '@yume-chan/adb';
import { LinuxFileType } from '@yume-chan/adb';
import type { MaybeConsumable } from '@yume-chan/stream-extra';
import type { DirectoryEntry, StorageInfo } from './types.js';
import { DEVICE_PATHS } from './types.js';
import { adbLog } from '$lib/stores/log.svelte.js';

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
export async function pullFile(adb: Adb, remotePath: string): Promise<Uint8Array> {
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
	adbLog.debug(`sync.lstat → ${remotePath} (pathExists)`);
	try {
		const sync = await adb.sync();
		try {
			const st = await sync.lstat(remotePath);
			const exists = st.mode !== 0;
			adbLog.debug(`sync.lstat ✓ ${remotePath} → ${exists ? 'exists' : 'not found'}`);
			return exists;
		} finally {
			await sync.dispose();
		}
	} catch (e) {
		adbLog.debug(`sync.lstat ✗ ${remotePath}: ${e}`);
		return false;
	}
}

/**
 * Check if a path is a directory on the device.
 * Uses lstat (works on NextUI devices) instead of stat.
 */
export async function isDirectory(adb: Adb, remotePath: string): Promise<boolean> {
	adbLog.debug(`sync.lstat → ${remotePath} (isDirectory)`);
	try {
		const sync = await adb.sync();
		try {
			const st = await sync.lstat(remotePath);
			const isDir = (st.mode & 0o170000) === 0o040000; // S_IFDIR
			adbLog.debug(`sync.lstat ✓ ${remotePath} → isDir=${isDir}`);
			return isDir;
		} finally {
			await sync.dispose();
		}
	} catch (e) {
		adbLog.debug(`sync.lstat ✗ ${remotePath}: ${e}`);
		return false;
	}
}

/**
 * Run a shell command on the device and return stdout.
 * Tries multiple approaches since some devices have limited ADB daemon support.
 *
 * @param adb - Active ADB connection
 * @param command - Shell command to execute
 * @returns Command stdout
 */
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
 * Get storage information for the SD card.
 *
 * @param adb - Active ADB connection
 * @returns Storage info or null if unavailable
 */
export async function getStorageInfo(adb: Adb): Promise<StorageInfo | null> {
	try {
		const output = await shell(adb, `df ${DEVICE_PATHS.base}`);
		const lines = output.trim().split('\n');
		if (lines.length < 2) return null;

		// Parse the data line (skip header)
		const dataLine = lines[lines.length - 1];
		const parts = dataLine.split(/\s+/);
		if (parts.length < 4) return null;

		const totalKb = parseInt(parts[1], 10);
		const usedKb = parseInt(parts[2], 10);
		const availableKb = parseInt(parts[3], 10);

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
export async function verifyNextUIInstallation(
	adb: Adb
): Promise<{ ok: boolean; error?: string }> {
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

	return { ok: true };
}

/**
 * Run a full diagnostic check against the connected device.
 * Tests all available APIs and returns detailed results for debugging.
 */
export async function runDiagnostics(
	adb: Adb
): Promise<{ label: string; status: 'ok' | 'fail' | 'skip'; detail: string }[]> {
	const results: { label: string; status: 'ok' | 'fail' | 'skip'; detail: string }[] = [];

	// 1. ADB banner / transport info
	try {
		results.push({
			label: 'ADB Transport',
			status: 'ok',
			detail: `serial=${adb.serial}, maxPayload=${adb.maxPayloadSize}, features=[${adb.banner.features?.join(', ') ?? 'none'}]`
		});
	} catch (e) {
		results.push({
			label: 'ADB Transport',
			status: 'fail',
			detail: String(e)
		});
	}

	// 2. Sync: opendir /
	try {
		const entries = await listDirectory(adb, '/');
		results.push({
			label: 'sync.opendir("/")',
			status: 'ok',
			detail: `${entries.length} entries: ${entries.map((e) => e.name).join(', ')}`
		});
	} catch (e) {
		results.push({
			label: 'sync.opendir("/")',
			status: 'fail',
			detail: String(e)
		});
	}

	// 3. Sync: opendir /mnt/SDCARD
	try {
		const entries = await listDirectory(adb, DEVICE_PATHS.base);
		const dirs = entries.filter((e) => e.isDirectory).map((e) => e.name);
		results.push({
			label: `sync.opendir("${DEVICE_PATHS.base}")`,
			status: 'ok',
			detail: `${entries.length} entries. Dirs: ${dirs.join(', ')}`
		});
	} catch (e) {
		results.push({
			label: `sync.opendir("${DEVICE_PATHS.base}")`,
			status: 'fail',
			detail: String(e)
		});
	}

	// 4. Sync: stat
	try {
		const sync = await adb.sync();
		try {
			const st = await sync.stat(DEVICE_PATHS.base);
			results.push({
				label: `sync.stat("${DEVICE_PATHS.base}")`,
				status: 'ok',
				detail: `mode=${st.mode}, size=${st.size}`
			});
		} finally {
			await sync.dispose();
		}
	} catch (e) {
		results.push({
			label: `sync.stat("${DEVICE_PATHS.base}")`,
			status: 'fail',
			detail: String(e)
		});
	}

	// 5. Sync: lstat
	try {
		const sync = await adb.sync();
		try {
			const st = await sync.lstat(DEVICE_PATHS.base);
			results.push({
				label: `sync.lstat("${DEVICE_PATHS.base}")`,
				status: 'ok',
				detail: `mode=${st.mode}, size=${st.size}`
			});
		} finally {
			await sync.dispose();
		}
	} catch (e) {
		results.push({
			label: `sync.lstat("${DEVICE_PATHS.base}")`,
			status: 'fail',
			detail: String(e)
		});
	}

	// 6. Sync: read a known file
	try {
		const content = await pullFile(adb, `${DEVICE_PATHS.base}/README.txt`);
		const text = new TextDecoder().decode(content.slice(0, 200));
		results.push({
			label: 'sync.read("README.txt")',
			status: 'ok',
			detail: `${content.byteLength} bytes. Start: ${text.substring(0, 80).replace(/\n/g, '\\n')}...`
		});
	} catch (e) {
		results.push({
			label: 'sync.read("README.txt")',
			status: 'fail',
			detail: String(e)
		});
	}

	// 7. Subprocess: noneProtocol
	try {
		const output = await adb.subprocess.noneProtocol.spawnWaitText('echo hello');
		results.push({
			label: 'subprocess.noneProtocol',
			status: 'ok',
			detail: `output="${output.trim()}"`
		});
	} catch (e) {
		results.push({
			label: 'subprocess.noneProtocol',
			status: 'fail',
			detail: String(e)
		});
	}

	// 8. Subprocess: shellProtocol
	try {
		const proto = adb.subprocess.shellProtocol;
		if (proto) {
			const result = await proto.spawnWaitText('echo hello');
			results.push({
				label: 'subprocess.shellProtocol',
				status: 'ok',
				detail: `stdout="${result.stdout.trim()}", exitCode=${result.exitCode}`
			});
		} else {
			results.push({
				label: 'subprocess.shellProtocol',
				status: 'skip',
				detail: 'Not available (shellProtocol is undefined)'
			});
		}
	} catch (e) {
		results.push({
			label: 'subprocess.shellProtocol',
			status: 'fail',
			detail: String(e)
		});
	}

	// 9. Raw shell socket
	try {
		const output = await adb.createSocketAndWait('shell:echo hello');
		results.push({
			label: 'createSocketAndWait("shell:...")',
			status: 'ok',
			detail: `output="${output.trim()}"`
		});
	} catch (e) {
		results.push({
			label: 'createSocketAndWait("shell:...")',
			status: 'fail',
			detail: String(e)
		});
	}

	// 10. Verify NextUI (using fixed pathExists)
	try {
		const result = await verifyNextUIInstallation(adb);
		results.push({
			label: 'verifyNextUIInstallation',
			status: result.ok ? 'ok' : 'fail',
			detail: result.ok ? 'Verified' : result.error ?? 'Unknown error'
		});
	} catch (e) {
		results.push({
			label: 'verifyNextUIInstallation',
			status: 'fail',
			detail: String(e)
		});
	}

	// 11. Storage info
	try {
		const info = await getStorageInfo(adb);
		if (info) {
			const toGB = (b: number) => (b / 1024 / 1024 / 1024).toFixed(2);
			results.push({
				label: 'getStorageInfo',
				status: 'ok',
				detail: `${toGB(info.usedBytes)} GB / ${toGB(info.totalBytes)} GB (${toGB(info.availableBytes)} GB free)`
			});
		} else {
			results.push({
				label: 'getStorageInfo',
				status: 'fail',
				detail: 'Returned null (shell may not be supported)'
			});
		}
	} catch (e) {
		results.push({
			label: 'getStorageInfo',
			status: 'fail',
			detail: String(e)
		});
	}

	return results;
}

/**
 * Compute SHA-256 checksum of data using the Web Crypto API.
 *
 * @param data - Data to hash
 * @returns Lowercase hex string of the SHA-256 hash
 */
export async function sha256(data: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
