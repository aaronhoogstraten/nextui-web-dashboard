import type { Adb } from '@yume-chan/adb';
import JSZip from 'jszip';
import { base } from '$app/paths';
import { DEVICE_PATHS } from './types.js';
import { pathExists, pushFile, shell } from './file-ops.js';
import { ShellCmd } from './adb-utils.js';
import { adbLog } from '$lib/stores/log.svelte.js';

/** Files from the zip to push to device. Others (README, LICENSE) are skipped. */
const PUSH_FILES: Record<string, { executable: boolean }> = {
	'launch.sh': { executable: true },
	'pak.json': { executable: false }
};

/** Prefix for platform-specific binaries inside the zip. */
const BIN_PREFIX = 'bin/';

/** Device /tmp paths used by the stay-awake workflow. */
const TMP_NEXT = '/tmp/next';
const TMP_STAY_AWAKE = '/tmp/stay_awake';
const SHOW2_FIFO = '/tmp/show2.fifo';

/** Remote path for the dashboard logo pushed to device. */
const DASHBOARD_IMAGE = '/tmp/dashboard.png';

/** show2.elf display parameters. */
const SHOW2_BG_COLOR = '0x1a1a2e';
const SHOW2_FONT_COLOR = '0xFFFFFF';
const SHOW2_TEXT_Y = 75;
const SHOW2_PROGRESS_Y_HIDDEN = 200;
const SHOW2_IDLE_TEXT = 'NextUI Web Dashboard in use - Press B to stop keeping the device awake';

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

	// Push files
	for (const { relativePath, data, executable } of filesToPush) {
		await pushFile(adb, `${pakDir}/${relativePath}`, data, executable ? 0o755 : 0o644);
		adbLog.debug(`Pushed ${relativePath} (${data.length} bytes)`);
	}

	adbLog.info(`Developer.pak installed (${filesToPush.length} files)`);
}

/**
 * Launch Developer.pak using the device's native pak-launching mechanism.
 * Writes the launch command to TMP_NEXT and kills nextui.elf, which triggers
 * the MinUI.pak main loop to execute the pak with the full system environment.
 * This is identical to how paks are launched from the device menu.
 */
export async function launchDevPakNative(adb: Adb, platform: string): Promise<void> {
	const script = launchScript(platform);
	adbLog.info('Launching Developer.pak via native mechanism');

	// Check if nextui.elf is at the menu. If TMP_NEXT exists, another pak is
	// currently running (the MinUI loop deletes it only after the pak exits).
	const nextExists = await pathExists(adb, TMP_NEXT);
	if (nextExists) {
		throw new Error(
			'Cannot launch Developer.pak: another pak is currently running. Return to the NextUI menu first.'
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

	adbLog.info('Developer.pak launched (nextui.elf will restart when pak exits)');
}

/**
 * Stop the stay-awake pak by killing minui-presenter.
 * Only acts if TMP_STAY_AWAKE exists (written by Developer.pak while active).
 * The pak's trap handler cleans up TMP_STAY_AWAKE and nextui.elf restarts.
 */
export async function stopDevPak(adb: Adb): Promise<void> {
	const active = await isStayAwakeActive(adb);
	if (!active) {
		adbLog.debug('Stay-awake not active, nothing to stop');
		return;
	}

	adbLog.info('Stopping Developer.pak stay-awake');
	await shell(adb, 'killall minui-presenter');
}

/**
 * Check if the Developer.pak is still actively running.
 * The pak writes TMP_STAY_AWAKE on launch and removes it via trap on exit.
 * Note: on NextUI, actual sleep control is managed by paks themselves
 * (the file doesn't suppress sleep), but the Developer.pak still writes it
 * so it serves as a reliable indicator of pak state.
 */
export async function isStayAwakeActive(adb: Adb): Promise<boolean> {
	return pathExists(adb, TMP_STAY_AWAKE);
}

/**
 * Launch show2.elf as an overlay on top of Developer.pak.
 * Pushes the dashboard logo to the device, then starts show2.elf in daemon mode.
 * Must be called after Developer.pak is running (so the framebuffer is available).
 */
export async function launchShow2Overlay(adb: Adb, platform: string, ldLibraryPath: string): Promise<void> {
	adbLog.info('Launching show2.elf overlay...');

	const systemDir = `${DEVICE_PATHS.system}/${platform}`;
	const show2 = `${systemDir}/bin/show2.elf`;

	// Push the dashboard logo to the device
	const url = `${base}/dashboard.png`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch dashboard image (${res.status})`);
	const imageData = new Uint8Array(await res.arrayBuffer());
	await pushFile(adb, DASHBOARD_IMAGE, imageData);
	adbLog.debug(`Pushed dashboard image (${imageData.length} bytes)`);

	// Clean up stale FIFO from previous runs
	await shell(adb, `rm -f ${SHOW2_FIFO}`);

	// Wait for Developer.pak to be running before launching the overlay.
	// After launchDevPakNative kills nextui.elf, the MinUI main loop needs time
	// to detect the exit, read /tmp/next, and start Developer.pak.
	const waitResult = await shell(
		adb,
		`for i in 1 2 3 4 5; do [ -f ${TMP_STAY_AWAKE} ] && echo READY && break; sleep 1; done`
	);
	if (!waitResult.trim().includes('READY')) {
		throw new Error('Developer.pak did not start within 5s');
	}

	// Launch show2.elf in a single shell session — it needs the session alive
	// while SDL initializes (~2s). The FIFO write updates the text after init,
	// and the trailing sleep gives show2 time to render the update.
	const result = await shell(
		adb,
		`LD_LIBRARY_PATH=${ldLibraryPath} ${show2} --mode=daemon --image=${DASHBOARD_IMAGE} --bgcolor=${SHOW2_BG_COLOR} --fontcolor=${SHOW2_FONT_COLOR} --texty=${SHOW2_TEXT_Y} --progressy=${SHOW2_PROGRESS_Y_HIDDEN} --text="Starting..." > /dev/null 2>&1 &
sleep 2
pidof show2.elf && echo OK || echo FAIL
echo "TEXT:${SHOW2_IDLE_TEXT}" > ${SHOW2_FIFO}
sleep 1`
	);

	const lines = result
		.trim()
		.split('\n')
		.map((l) => l.trim());
	if (!lines.includes('OK')) {
		throw new Error('show2.elf overlay failed to start');
	}
	adbLog.info('show2.elf overlay active');
}

/**
 * Stop the show2.elf overlay.
 * Uses killall since FIFO writes don't work across ADB shell sessions.
 */
export async function stopShow2(adb: Adb): Promise<void> {
	try {
		await shell(adb, `killall show2.elf 2>/dev/null || true; rm -f ${DASHBOARD_IMAGE} ${SHOW2_FIFO}`);
	} catch {
		// Best-effort cleanup
	}
}
