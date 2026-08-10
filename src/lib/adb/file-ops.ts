import type { Adb } from '@yume-chan/adb';
import { LinuxFileType } from '@yume-chan/adb';
import type { MaybeConsumable } from '@yume-chan/stream-extra';
import JSZip from 'jszip';
import type { DirectoryEntry, StorageInfo } from './types.js';
import { DEVICE_PATHS } from './types.js';
import { adbLog } from '$lib/stores/log.svelte.js';
import { formatError, joinPath } from '$lib/utils.js';
import { ShellCmd } from './adb-utils.js';

/** Progress callback for file transfers: (bytesTransferred, totalBytes). totalBytes is -1 if unknown. */
export type TransferProgressCallback = (bytesTransferred: number, totalBytes: number) => void;

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
	permission = 0o644,
	onProgress?: TransferProgressCallback
): Promise<void> {
	adbLog.info(
		`sync.write → ${remotePath} (${content.byteLength} bytes, perm=${permission.toString(8)})`
	);
	const sync = await adb.sync();
	try {
		const CHUNK_SIZE = 64 * 1024;
		let offset = 0;
		const stream = new ReadableStream<MaybeConsumable<Uint8Array>>({
			pull(controller) {
				if (offset >= content.byteLength) {
					controller.close();
					return;
				}
				const end = Math.min(offset + CHUNK_SIZE, content.byteLength);
				controller.enqueue(content.subarray(offset, end));
				offset = end;
				onProgress?.(offset, content.byteLength);
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
export async function pullFile(
	adb: Adb,
	remotePath: string,
	onProgress?: TransferProgressCallback
): Promise<Uint8Array<ArrayBuffer>> {
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
			onProgress?.(totalLength, -1);
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

/** A file found by walkDirectory, with its path relative to the walk root. */
export interface WalkedFile {
	/** Absolute path on the device */
	path: string;
	/** Path relative to the walk root, e.g. "GB/Zelda.gb" */
	relativePath: string;
	size: bigint;
	/** Unix mtime in seconds; 0 when the device didn't report one */
	mtime: bigint;
}

export interface WalkResult {
	files: WalkedFile[];
	/** Sum of all file sizes, in bytes */
	totalBytes: number;
	/** Directories that could not be listed (permissions, vanished mid-walk) */
	skipped: string[];
	/** Directories left unvisited because they sat below maxDepth */
	tooDeep: string[];
	/** True if a cap stopped the walk short of the full tree */
	truncated: boolean;
	/**
	 * True if `onLimit` declined a cap. The walk stops immediately and the
	 * partial result should be discarded, not used.
	 */
	aborted: boolean;
}

/** A cap the walk has run into, passed to onLimit so the caller can lift it. */
export interface WalkLimit {
	kind: 'files' | 'depth';
	/** The cap that was reached */
	limit: number;
}

export interface WalkOptions {
	maxDepth?: number;
	maxFiles?: number;
	/**
	 * Called when a cap is reached. Return true to lift that cap for the rest of
	 * the walk, or false to abandon the walk entirely — declining sets `aborted`
	 * and stops immediately rather than handing back a partial tree. Without this
	 * callback the caps are hard and simply truncate.
	 */
	onLimit?: (limit: WalkLimit) => boolean | Promise<boolean>;
	/** Called after each directory is listed, with the running file count */
	onProgress?: (filesFound: number, currentDir: string) => void;
}

/**
 * Recursively enumerate every file under a directory.
 *
 * Breadth-first, so shallow files are known early. Entries that are neither a
 * regular file nor a directory (symlinks, sockets, device nodes) are ignored —
 * which also means symlink loops cannot trap the walk. Directories that fail to
 * list are recorded in `skipped` rather than aborting the whole walk, since a
 * single unreadable folder shouldn't sink a large download.
 *
 * The file and depth caps are soft when `onLimit` is supplied: the walk asks
 * once per cap and carries on if told to, so a caller can let the user opt into
 * scanning an unusually large tree. Declining aborts the walk on the spot — a
 * caller that says "no" wants out, not a half-scanned tree it has to explain.
 *
 * @param adb - Active ADB connection
 * @param rootPath - Directory to walk
 * @returns Every file found, with sizes, plus what was skipped
 */
export async function walkDirectory(
	adb: Adb,
	rootPath: string,
	options: WalkOptions = {}
): Promise<WalkResult> {
	const { maxDepth = 16, maxFiles = 20000, onLimit, onProgress } = options;

	const files: WalkedFile[] = [];
	const skipped: string[] = [];
	const tooDeep: string[] = [];
	let totalBytes = 0;
	let truncated = false;
	let aborted = false;

	// Effective caps — raised to Infinity if the caller waives one. Once waived a
	// cap can never be reached again, so onLimit is asked at most once per kind.
	let fileCap = maxFiles;
	let depthCap = maxDepth;

	/** Ask whether to keep going past a cap. True means the cap is lifted. */
	async function liftCap(kind: WalkLimit['kind'], limit: number): Promise<boolean> {
		if (!onLimit) {
			// No arbiter — the cap is hard, so the result is simply incomplete
			truncated = true;
			return false;
		}

		if (await onLimit({ kind, limit })) {
			if (kind === 'files') {
				fileCap = Number.POSITIVE_INFINITY;
			} else {
				depthCap = Number.POSITIVE_INFINITY;
			}
			adbLog.info(`walk: ${kind} cap of ${limit} waived, continuing`);
			return true;
		}

		aborted = true;
		truncated = true;
		adbLog.info(`walk: ${kind} cap of ${limit} declined, aborting`);
		return false;
	}

	const queue: { path: string; relative: string; depth: number }[] = [
		{ path: rootPath, relative: '', depth: 0 }
	];

	adbLog.info(`walk → ${rootPath}`);
	while (queue.length > 0) {
		const dir = queue.shift()!;

		let entries: DirectoryEntry[];
		try {
			entries = await listDirectory(adb, dir.path);
		} catch (e) {
			adbLog.warn(`walk: skipping ${dir.path}: ${formatError(e)}`);
			skipped.push(dir.path);
			continue;
		}

		for (const entry of entries) {
			const childPath = joinPath(dir.path, entry.name);
			const childRelative = dir.relative ? `${dir.relative}/${entry.name}` : entry.name;

			if (entry.isFile) {
				if (files.length >= fileCap && !(await liftCap('files', maxFiles))) {
					// A hard cap keeps scanning to report an accurate skipped set;
					// an abort means nobody will read the result, so stop now
					if (aborted) break;
					continue;
				}
				files.push({
					path: childPath,
					relativePath: childRelative,
					size: entry.size,
					mtime: entry.mtime
				});
				totalBytes += Number(entry.size);
			} else if (entry.isDirectory) {
				if (dir.depth + 1 > depthCap && !(await liftCap('depth', maxDepth))) {
					if (aborted) break;
					tooDeep.push(childPath);
					continue;
				}
				queue.push({ path: childPath, relative: childRelative, depth: dir.depth + 1 });
			}
		}

		if (aborted) break;
		onProgress?.(files.length, dir.path);
	}

	if (aborted) {
		adbLog.info(`walk ✗ ${rootPath} aborted after ${files.length} files`);
		return { files, totalBytes, skipped, tooDeep, truncated, aborted };
	}

	adbLog.info(
		`walk ✓ ${rootPath} (${files.length} files, ${totalBytes} bytes, ` +
			`${skipped.length} unreadable, ${tooDeep.length} too deep)`
	);
	return { files, totalBytes, skipped, tooDeep, truncated, aborted };
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
		const raw = await adb.createSocketAndWait(`shell:${command}`);
		const result = raw.replace(/\r\n/g, '\n');
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
			const t = parseInt(parts[1], 10),
				u = parseInt(parts[2], 10),
				a = parseInt(parts[3], 10);
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
export type VerifyResult = { ok: true; version?: string } | { ok: false; error: string };

/**
 * Log what is actually present on the device after verification fails.
 *
 * A failed connection from an unfamiliar platform is otherwise a dead end —
 * the log says which path was missing but not where the SD card really is.
 * Best-effort: never throws, so it cannot mask the original failure.
 */
export async function logInstallDiagnostics(adb: Adb): Promise<void> {
	for (const root of ['/mnt', DEVICE_PATHS.base]) {
		try {
			const entries = await listDirectory(adb, root);
			const names = entries.map((e) => (e.isDirectory ? `${e.name}/` : e.name));
			const shown = names.slice(0, 60).join(' ');
			const more = names.length > 60 ? ` … (+${names.length - 60} more)` : '';
			adbLog.info(`Contents of ${root}: ${shown || '(empty)'}${more}`);
		} catch (e) {
			adbLog.info(`Contents of ${root}: unavailable (${e})`);
		}
	}
}

export async function verifyNextUIInstallation(adb: Adb): Promise<VerifyResult> {
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
					error:
						'This device appears to be running a non-NextUI fork of MinUI. The dashboard only supports NextUI.'
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

	results.push(
		await test('ADB Transport', async () =>
			`serial=${adb.serial}, maxPayload=${adb.maxPayloadSize}, features=[${adb.banner.features?.join(', ') ?? 'none'}]`)
	);

	results.push(
		await test('sync.opendir("/")', async () => {
			const entries = await listDirectory(adb, '/');
			return `${entries.length} entries: ${entries.map((e) => e.name).join(', ')}`;
		})
	);

	results.push(
		await test(`sync.opendir("${DEVICE_PATHS.base}")`, async () => {
			const entries = await listDirectory(adb, DEVICE_PATHS.base);
			const dirs = entries.filter((e) => e.isDirectory).map((e) => e.name);
			return `${entries.length} entries. Dirs: ${dirs.join(', ')}`;
		})
	);

	results.push(
		await test(`sync.stat("${DEVICE_PATHS.base}")`, async () => {
			const sync = await adb.sync();
			try {
				const st = await sync.stat(DEVICE_PATHS.base);
				return `mode=${st.mode}, size=${st.size}`;
			} finally {
				await sync.dispose();
			}
		})
	);

	results.push(
		await test(`sync.lstat("${DEVICE_PATHS.base}")`, async () => {
			const sync = await adb.sync();
			try {
				const st = await sync.lstat(DEVICE_PATHS.base);
				return `mode=${st.mode}, size=${st.size}`;
			} finally {
				await sync.dispose();
			}
		})
	);

	results.push(
		await test('sync.read("README.txt")', async () => {
			const content = await pullFile(adb, `${DEVICE_PATHS.base}/README.txt`);
			const text = new TextDecoder().decode(content.slice(0, 200));
			return `${content.byteLength} bytes. Start: ${text.substring(0, 80).replace(/\n/g, '\\n')}...`;
		})
	);

	results.push(
		await test('subprocess.noneProtocol', async () => {
			const output = await adb.subprocess.noneProtocol.spawnWaitText('echo hello');
			return `output="${output.trim()}"`;
		})
	);

	// shellProtocol — may not be available
	try {
		const proto = adb.subprocess.shellProtocol;
		if (proto) {
			results.push(
				await test('subprocess.shellProtocol', async () => {
					const result = await proto.spawnWaitText('echo hello');
					return `stdout="${result.stdout.trim()}", exitCode=${result.exitCode}`;
				})
			);
		} else {
			results.push({
				label: 'subprocess.shellProtocol',
				status: 'skip',
				detail: 'Not available (shellProtocol is undefined)'
			});
		}
	} catch (e) {
		results.push({ label: 'subprocess.shellProtocol', status: 'fail', detail: String(e) });
	}

	results.push(
		await test('createSocketAndWait("shell:...")', async () => {
			const output = await adb.createSocketAndWait('shell:echo hello');
			return `output="${output.trim()}"`;
		})
	);

	results.push(
		await test('verifyNextUIInstallation', async () => {
			const result = await verifyNextUIInstallation(adb);
			if (!result.ok) throw new Error(result.error ?? 'Unknown error');
			return 'Verified';
		})
	);

	results.push(
		await test('getStorageInfo', async () => {
			const info = await getStorageInfo(adb);
			if (!info) throw new Error('Returned null (shell may not be supported)');
			const toGB = (b: number) => (b / 1024 / 1024 / 1024).toFixed(2);
			return `${toGB(info.usedBytes)} GB / ${toGB(info.totalBytes)} GB (${toGB(info.availableBytes)} GB free)`;
		})
	);

	return results;
}
