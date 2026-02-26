import type { Adb } from '@yume-chan/adb';
import JSZip from 'jszip';
import { base } from '$app/paths';
import { DEVICE_PATHS } from './types.js';
import { pathExists, pushFile, shell } from './file-ops.js';
import { ShellCmd } from './adb-utils.js';
import { adbLog } from '$lib/stores/log.svelte.js';

/** Cached supported platforms from developer-pak.json. */
let supportedPlatforms: Set<string> | null = null;

/** Fetch supported platforms from the bundled developer-pak.json. */
async function loadSupportedPlatforms(): Promise<Set<string>> {
	if (supportedPlatforms) return supportedPlatforms;
	try {
		const res = await fetch(`${base}/developer-pak.json`);
		if (!res.ok) throw new Error(`${res.status}`);
		const data = await res.json();
		supportedPlatforms = new Set(data.platforms ?? []);
	} catch (e) {
		adbLog.warn(`Failed to load developer-pak.json: ${e}`);
		supportedPlatforms = new Set();
	}
	return supportedPlatforms;
}

/** Check if the detected platform supports the stay-awake feature. */
export async function isStayAwakeSupported(platform: string): Promise<boolean> {
	const platforms = await loadSupportedPlatforms();
	return platforms.has(platform);
}

/** Files from the zip to push to device. Others (README, LICENSE) are skipped. */
const PUSH_FILES: Record<string, { executable: boolean }> = {
	'launch.sh': { executable: true },
	'pak.json': { executable: false }
};

/** Remote path for the dashboard logo pushed to device. */
const DASHBOARD_IMAGE = '/tmp/dashboard.png';

/** Dashboard overlay display parameters (passed to minui-presenter). */
const OVERLAY_BG_COLOR = '#1a1a2e';
const OVERLAY_MESSAGE = 'NextUI Dashboard in use';

/** The dashboard minui-presenter command that replaces the default invocation in launch.sh. */
const DASHBOARD_PRESENTER_CMD =
	`minui-presenter --background-image ${DASHBOARD_IMAGE} --background-color "${OVERLAY_BG_COLOR}"` +
	` --message "${OVERLAY_MESSAGE}" --message-alignment middle --show-pill --cancel-show --cancel-text "EXIT" --timeout 0`;

/**
 * Regex matching the minui-presenter invocation line in launch.sh.
 * Matches lines like: `    minui-presenter --message "Press B to exit" --timeout 0`
 * Avoids matching `killall minui-presenter`, `command -v minui-presenter`, or `chmod` lines.
 */
const PRESENTER_INVOCATION_RE = /^(\s*)minui-presenter\s+--/m;

/** Prefix for platform-specific binaries inside the zip. */
const BIN_PREFIX = 'bin/';

/** Device /tmp paths used by the stay-awake workflow. */
const TMP_NEXT = '/tmp/next';
const TMP_STAY_AWAKE = '/tmp/stay_awake';

function devPakDir(platform: string): string {
	return `${DEVICE_PATHS.tools}/${platform}/DashboardDeveloper.pak`;
}

function launchScript(platform: string): string {
	return `${devPakDir(platform)}/launch.sh`;
}

/**
 * Check if the DashboardDeveloper.pak is already installed on the device.
 */
export async function isDevPakInstalled(adb: Adb, platform: string): Promise<boolean> {
	return pathExists(adb, launchScript(platform));
}

/**
 * Install the DashboardDeveloper.pak by fetching the bundled zip and extracting to device.
 * The zip is downloaded at build time by CI (see scripts/fetch-developer-pak.sh).
 */
export async function installDevPak(adb: Adb, platform: string): Promise<void> {
	const pakDir = devPakDir(platform);
	adbLog.info(`Installing DashboardDeveloper.pak to ${pakDir}`);

	// Fetch the zip from static assets
	const url = `${base}/developer-pak.zip`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch Developer.pak zip (${res.status})`);

	const zip = await JSZip.loadAsync(await res.arrayBuffer());

	// Collect files to push and the unique parent directories they need
	const filesToPush: { relativePath: string; data: Uint8Array; executable: boolean }[] = [];
	const dirsNeeded = new Set<string>([pakDir]);

	for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
		if (zipEntry.dir) continue;

		const known = PUSH_FILES[relativePath];
		const isBin = relativePath.startsWith(BIN_PREFIX);
		if (!known && !isBin) continue; // skip README, LICENSE, etc.

		const executable = known ? known.executable : true; // binaries are executable
		const data = new Uint8Array(await zipEntry.async('arraybuffer'));
		filesToPush.push({ relativePath, data, executable });

		const lastSlash = relativePath.lastIndexOf('/');
		if (lastSlash > 0) {
			dirsNeeded.add(`${pakDir}/${relativePath.substring(0, lastSlash)}`);
		}
	}

	if (filesToPush.length === 0) throw new Error('No Developer.pak files found in zip');

	// Create all needed directories (one round-trip each, deduplicated)
	for (const dir of dirsNeeded) {
		await shell(adb, ShellCmd.mkdir(dir).toString());
	}

	// Push files, patching the minui-presenter invocation in launch.sh
	for (const file of filesToPush) {
		let data = file.data;
		if (file.relativePath === 'launch.sh') {
			const script = new TextDecoder().decode(data);
			const match = PRESENTER_INVOCATION_RE.exec(script);
			if (match) {
				const patched = script.replace(PRESENTER_INVOCATION_RE, `${match[1]}${DASHBOARD_PRESENTER_CMD}`);
				data = new TextEncoder().encode(patched);
				adbLog.debug('Patched launch.sh with dashboard minui-presenter command');
			} else {
				adbLog.warn('launch.sh: minui-presenter invocation line not found, installing unmodified');
			}
		}
		await pushFile(adb, `${pakDir}/${file.relativePath}`, data, file.executable ? 0o755 : 0o644);
		adbLog.debug(`Pushed ${file.relativePath} (${data.length} bytes)`);
	}

	adbLog.info(`DashboardDeveloper.pak installed (${filesToPush.length} files)`);
}

/**
 * Launch DashboardDeveloper.pak using the device's native pak-launching mechanism.
 * Writes the launch command to TMP_NEXT and kills nextui.elf, which triggers
 * the MinUI.pak main loop to execute the pak with the full system environment.
 * This is identical to how paks are launched from the device menu.
 */
export async function launchDevPakNative(adb: Adb, platform: string): Promise<void> {
	const script = launchScript(platform);
	adbLog.info('Launching DashboardDeveloper.pak via native mechanism');

	// Check if nextui.elf is at the menu. If TMP_NEXT exists, another pak is
	// currently running (the MinUI loop deletes it only after the pak exits).
	const nextExists = await pathExists(adb, TMP_NEXT);
	if (nextExists) {
		throw new Error(
			'Cannot launch DashboardDeveloper.pak: another pak is currently running. Return to the NextUI menu first.'
		);
	}

	// Write the launch command to TMP_NEXT (same format nextui.elf uses)
	const expectedCmd = `sh ${script}`;
	await shell(adb, `echo '${expectedCmd}' > ${TMP_NEXT}`);

	// Verify the write succeeded and nextui.elf is ready to be replaced
	const written = (await shell(adb, `cat ${TMP_NEXT}`)).trim();
	adbLog.debug(`${TMP_NEXT} after: "${written}"`);
	if (written !== expectedCmd) {
		throw new Error(`Failed to write launch command to ${TMP_NEXT} (got: "${written}")`);
	}

	// Use SIGKILL (-9) to terminate nextui.elf immediately.
	// SIGTERM would trigger SDL_QUIT → PWR_powerOff() which shows "Powering off",
	// kills daemons (keymon, batmon, audiomon), and removes /tmp/nextui_exec
	// (which would cause the MinUI loop to exit after the pak finishes).
	// SIGKILL bypasses all signal handlers so none of that happens.
	await shell(adb, 'killall -9 nextui.elf');

	adbLog.info('DashboardDeveloper.pak launched (nextui.elf will restart when pak exits)');
}

/**
 * Stop the stay-awake pak by killing minui-presenter.
 * Only acts if TMP_STAY_AWAKE exists (written by DashboardDeveloper.pak while active).
 * The pak's trap handler cleans up TMP_STAY_AWAKE and nextui.elf restarts.
 */
export async function stopDevPak(adb: Adb): Promise<void> {
	const active = await isStayAwakeActive(adb);
	if (!active) {
		adbLog.debug('Stay-awake not active, nothing to stop');
		return;
	}

	adbLog.info('Stopping DashboardDeveloper.pak stay-awake');
	await shell(adb, 'killall minui-presenter');
}

/**
 * Check if the DashboardDeveloper.pak is still actively running.
 * The pak writes TMP_STAY_AWAKE on launch and removes it via trap on exit.
 * Note: on NextUI, actual sleep control is managed by paks themselves
 * (the file doesn't suppress sleep), but the DashboardDeveloper.pak still writes it
 * so it serves as a reliable indicator of pak state.
 */
export async function isStayAwakeActive(adb: Adb): Promise<boolean> {
	return pathExists(adb, TMP_STAY_AWAKE);
}

/**
 * Push the dashboard logo to the device so the patched launch.sh can display it.
 * Must be called BEFORE launching DashboardDeveloper.pak, since the patched launch.sh
 * references the image path directly in its minui-presenter command.
 */
export async function pushDashboardImage(adb: Adb): Promise<void> {
	adbLog.info('Pushing dashboard image...');
	const url = `${base}/dashboard.png`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch dashboard image (${res.status})`);
	const imageData = new Uint8Array(await res.arrayBuffer());
	await pushFile(adb, DASHBOARD_IMAGE, imageData);
	adbLog.debug(`Pushed dashboard image (${imageData.length} bytes)`);
}
