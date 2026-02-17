import type { Adb, AdbSocket } from '@yume-chan/adb';
import JSZip from 'jszip';
import { base } from '$app/paths';
import { DEVICE_PATHS } from './types.js';
import { pathExists, pushFile, shell } from './file-ops.js';
import { ShellCmd } from './adb-utils.js';
import { adbLog } from '$lib/stores/log.svelte.js';
import { formatError } from '$lib/utils.js';

/** Files from the zip to push to device. Others (README, LICENSE) are skipped. */
const PUSH_FILES: Record<string, { executable: boolean }> = {
	'launch.sh': { executable: true },
	'pak.json': { executable: false }
};

/** Prefix for platform-specific binaries inside the zip. */
const BIN_PREFIX = 'bin/';

function devPakDir(platform: string): string {
	return `${DEVICE_PATHS.tools}/${platform}/Developer.pak`;
}

function launchScript(platform: string): string {
	return `${devPakDir(platform)}/launch.sh`;
}

/**
 * Check if the Developer.pak is already installed on the device.
 */
export async function isDevPakInstalled(adb: Adb, platform: string): Promise<boolean> {
	return pathExists(adb, launchScript(platform));
}

/**
 * Install the Developer.pak by fetching the bundled zip and extracting to device.
 * The zip is downloaded at build time by CI (see scripts/fetch-developer-pak.sh).
 */
export async function installDevPak(adb: Adb, platform: string): Promise<void> {
	const pakDir = devPakDir(platform);
	adbLog.info(`Installing Developer.pak to ${pakDir}`);

	// Fetch the zip from static assets
	const url = `${base}/developer-pak.zip`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch Developer.pak zip (${res.status})`);

	const zip = await JSZip.loadAsync(await res.arrayBuffer());
	let pushed = 0;

	for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
		if (zipEntry.dir) continue;

		// Determine if this file should be pushed
		const known = PUSH_FILES[relativePath];
		const isBin = relativePath.startsWith(BIN_PREFIX);

		if (!known && !isBin) continue; // skip README, LICENSE, etc.

		const executable = known ? known.executable : true; // binaries are executable
		const data = new Uint8Array(await zipEntry.async('arraybuffer'));
		const remotePath = `${pakDir}/${relativePath}`;

		// Create parent directory on device
		const lastSlash = relativePath.lastIndexOf('/');
		if (lastSlash > 0) {
			const subDir = `${pakDir}/${relativePath.substring(0, lastSlash)}`;
			await adb.createSocketAndWait(`shell:${ShellCmd.mkdir(subDir).toString()}`);
		} else {
			await adb.createSocketAndWait(`shell:${ShellCmd.mkdir(pakDir).toString()}`);
		}

		await pushFile(adb, remotePath, data, executable ? 0o755 : 0o644);
		pushed++;
		adbLog.debug(`Pushed ${relativePath} (${data.length} bytes)`);
	}

	if (pushed === 0) throw new Error('No Developer.pak files found in zip');
	adbLog.info(`Developer.pak installed (${pushed} files)`);
}

/**
 * Read all `export VAR=value` lines from the device's MinUI.pak launch.sh
 * and resolve shell variable references (e.g. $SDCARD_PATH) in order.
 * This is the authoritative source for the environment that NextUI provides
 * to paks at runtime — no hardcoded vendor paths needed.
 */
async function pakEnv(adb: Adb, platform: string): Promise<string> {
	const system = `${DEVICE_PATHS.base}/.system/${platform}`;
	const launcherPath = `${system}/paks/MinUI.pak/launch.sh`;

	try {
		const result = await shell(adb, `grep "^export " ${launcherPath}`);
		const resolved: Record<string, string> = {};

		for (const rawLine of result.trim().split('\n')) {
			const line = rawLine.replace(/\r$/, '');
			// Parse: export VAR="value" or export VAR=value
			const match = line.match(/^export\s+(\w+)=["']?(.+?)["']?$/);
			if (!match) continue;

			const [, key, raw] = match;

			// Skip backtick/subshell expressions (e.g. TRIMUI_MODEL=`strings ...`)
			if (raw.includes('`') || raw.includes('$(')) continue;

			// Resolve $VAR references using previously resolved values.
			// Self-references (e.g. $PATH in PATH=...:$PATH) are kept as-is
			// so the shell appends to the existing value at runtime.
			const value = raw.replace(/\$(\w+)/g, (_, ref) => {
				if (ref === key) return `\$${ref}`;
				return resolved[ref] ?? '';
			});

			// Strip trailing colons left from resolved-away references
			resolved[key] = value.replace(/:+$/, '');
		}

		if (Object.keys(resolved).length > 0) {
			adbLog.debug(`Pak env from device: ${JSON.stringify(resolved)}`);
			return Object.entries(resolved)
				.map(([k, v]) => `${k}=${v}`)
				.join(' ');
		}
	} catch {
		adbLog.debug('Could not read MinUI.pak launch.sh, using fallback env');
	}

	// Fallback: construct minimal env from known paths
	const sdcard = DEVICE_PATHS.base;
	const userdata = `${sdcard}/.userdata/${platform}`;
	adbLog.debug('Using fallback pak environment');
	return [
		`PLATFORM=${platform}`,
		`SDCARD_PATH=${sdcard}`,
		`SYSTEM_PATH=${system}`,
		`USERDATA_PATH=${userdata}`,
		`LOGS_PATH=${userdata}/logs`
	].join(' ');
}

/**
 * Launch the Developer.pak's launch.sh via an ADB shell socket.
 * Sets the environment variables that NextUI's launcher normally provides.
 * Returns the open socket — keep it alive to maintain the stay-awake state.
 * When the socket is closed (or USB disconnects), the pak's trap handler cleans up.
 */
export async function launchDevPak(adb: Adb, platform: string): Promise<AdbSocket> {
	const script = launchScript(platform);
	const env = await pakEnv(adb, platform);

	// Ensure logs directory exists (launch.sh redirects output there)
	const logsDir = `${DEVICE_PATHS.base}/.userdata/${platform}/logs`;
	await adb.createSocketAndWait(`shell:${ShellCmd.mkdir(logsDir).toString()}`);

	adbLog.info('Launching Developer.pak stay-awake');
	const socket = await adb.createSocket(`shell:${env} sh ${script}`);

	// Diagnostic: read the on-device log and check /tmp/stay_awake after launch
	const logFile = `${DEVICE_PATHS.base}/.userdata/${platform}/logs/Developer.txt`;
	setTimeout(async () => {
		try {
			const log = await shell(adb, `cat ${logFile}`);
			if (log.trim()) adbLog.debug(`Developer.pak log:\n${log.trim()}`);
		} catch { /* ignore */ }
		try {
			const sa = await shell(adb, 'cat /tmp/stay_awake');
			adbLog.debug(`/tmp/stay_awake: "${sa.trim()}"`);
		} catch {
			adbLog.debug('/tmp/stay_awake: file not found');
		}
	}, 3000);

	return socket;
}

/**
 * Stop the stay-awake session by closing the shell socket.
 * This triggers the on-device trap handler which removes /tmp/stay_awake.
 */
export async function stopStayAwake(socket: AdbSocket): Promise<void> {
	try {
		await socket.close();
	} catch (e) {
		adbLog.debug(`Stay-awake socket close: ${formatError(e)}`);
	}
}
