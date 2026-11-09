import type { Adb } from '@yume-chan/adb';
import JSZip from 'jszip';
import { base } from '$app/paths';
import { pathExists, pushFile, shell } from './file-ops.js';
import { ShellCmd } from './adb-utils.js';
import { launchPakNative } from './pak.js';
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
 * Whole lines in launch.sh that run minui-presenter, like
 * `    minui-presenter --message "Press B to exit" --timeout 0`.
 * Lines starting `killall minui-presenter`, `command -v minui-presenter` or
 * `chmod` don't count, since the line has to start with the command.
 */
const PRESENTER_LINE_RE = /^(\s*)minui-presenter\s+--.*$/gm;

/**
 * Swap the pak's own screen for the dashboard's, replacing the whole line so
 * none of the original arguments are left on the end. Since 0.11.0 the script
 * also has a `show_message` helper that runs minui-presenter with `"$message"`,
 * so lines passing shell variables are skipped. Returns null unless exactly one
 * line qualifies, rather than guess.
 */
export function patchLaunchScript(script: string): string | null {
	const candidates = [...script.matchAll(PRESENTER_LINE_RE)].filter((m) => !m[0].includes('$'));
	if (candidates.length !== 1) return null;
	const [line, indent] = candidates[0];
	// A function replacement, so nothing in the command reads as a `$` pattern
	return script.replace(line, () => `${indent}${DASHBOARD_PRESENTER_CMD}`);
}

/** Prefix for platform-specific binaries inside the zip. */
const BIN_PREFIX = 'bin/';

/** Device /tmp path used by the stay-awake workflow. */
const TMP_STAY_AWAKE = '/tmp/stay_awake';

const DEV_PAK_DIR = '/tmp/DashboardDeveloper.pak';
const LAUNCH_SCRIPT = `${DEV_PAK_DIR}/launch.sh`;

/**
 * Check if the DashboardDeveloper.pak is already installed on the device.
 */
export async function isDevPakInstalled(adb: Adb): Promise<boolean> {
	return pathExists(adb, LAUNCH_SCRIPT);
}

/**
 * Install the DashboardDeveloper.pak by fetching the bundled zip and extracting to device.
 * The zip is downloaded at build time by CI (see scripts/fetch-developer-pak.sh).
 */
export async function installDevPak(adb: Adb): Promise<void> {
	adbLog.info(`Installing DashboardDeveloper.pak to ${DEV_PAK_DIR}`);

	// Fetch the zip from static assets
	const url = `${base}/developer-pak.zip`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch Developer.pak zip (${res.status})`);

	const zip = await JSZip.loadAsync(await res.arrayBuffer());

	// Collect files to push and the unique parent directories they need
	const filesToPush: { relativePath: string; data: Uint8Array; executable: boolean }[] = [];
	const dirsNeeded = new Set<string>([DEV_PAK_DIR]);

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
			dirsNeeded.add(`${DEV_PAK_DIR}/${relativePath.substring(0, lastSlash)}`);
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
			const patched = patchLaunchScript(new TextDecoder().decode(data));
			if (patched !== null) {
				data = new TextEncoder().encode(patched);
				adbLog.debug('Patched launch.sh with dashboard minui-presenter command');
			} else {
				adbLog.warn('launch.sh: minui-presenter invocation line not found, installing unmodified');
			}
		}
		await pushFile(
			adb,
			`${DEV_PAK_DIR}/${file.relativePath}`,
			data,
			file.executable ? 0o755 : 0o644
		);
		adbLog.debug(`Pushed ${file.relativePath} (${data.length} bytes)`);
	}

	adbLog.info(`DashboardDeveloper.pak installed (${filesToPush.length} files)`);
}

/**
 * Launch DashboardDeveloper.pak using the device's native pak-launching mechanism.
 * SIGKILL is used (inside launchPakNative) so SDL_QUIT handlers don't fire —
 * those would show "Powering off", kill daemons (keymon, batmon, audiomon),
 * and remove /tmp/nextui_exec, causing the MinUI loop to exit after the pak.
 */
export async function launchDevPakNative(adb: Adb): Promise<void> {
	await launchPakNative(adb, LAUNCH_SCRIPT);
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
