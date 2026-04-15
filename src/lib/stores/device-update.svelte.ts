import {
	disableStayAwake,
	disconnect,
	getConnection,
	getNextUIVersion,
	getPlatform,
	isConnected,
	isStayAwakeActive
} from '$lib/stores/connection.svelte.js';
import { adbLog } from '$lib/stores/log.svelte.js';
import { launchPakNative, waitForPakSlotFree } from '$lib/adb/pak.js';
import { stopDevPak } from '$lib/adb/stay-awake.js';
import { DEVICE_PATHS } from '$lib/adb/types.js';
import { pathExists } from '$lib/adb/file-ops.js';
import { formatError } from '$lib/utils.js';

let latestRelease: string = $state('');
let dismissed: boolean = $state(false);
let fetchStatus: 'idle' | 'fetching' | 'done' | 'error' = $state('idle');
let openUpdaterBusy: boolean = $state(false);
let openUpdaterError: string = $state('');

/** Parse "NextUI-YYYYMMDD-N" → [YYYYMMDD, N] for comparison. */
function parseNextUIVersion(str: string): [number, number] | null {
	const m = str.match(/NextUI-(\d{8})-(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2])];
}

function isOlderThan(device: string, latest: string): boolean {
	const d = parseNextUIVersion(device);
	const l = parseNextUIVersion(latest);
	if (!d || !l) return false;
	if (d[0] !== l[0]) return d[0] < l[0];
	return d[1] < l[1];
}

export function isDeviceUpdateAvailable(): boolean {
	const deviceVersion = getNextUIVersion().split('\n')[0];
	return (
		isConnected() &&
		fetchStatus === 'done' &&
		!dismissed &&
		isOlderThan(deviceVersion, latestRelease)
	);
}

export function getLatestNextUIVersion(): string {
	return latestRelease;
}

export function dismissDeviceUpdate(): void {
	dismissed = true;
}

export function isOpenUpdaterBusy(): boolean {
	return openUpdaterBusy;
}

export function getOpenUpdaterError(): string {
	return openUpdaterError;
}

export function dismissOpenUpdaterError(): void {
	openUpdaterError = '';
}

/**
 * Launch the on-device Updater.pak, then disconnect the dashboard from the device.
 * Killing nextui.elf tears down the ADB transport, so we disconnect afterward to
 * clean up the dashboard's session state regardless.
 */
export async function openUpdater(): Promise<void> {
	if (openUpdaterBusy) return;
	const conn = getConnection();
	const platform = getPlatform();
	if (!conn || !platform) return;

	openUpdaterBusy = true;
	openUpdaterError = '';
	try {
		const launchScript = `${DEVICE_PATHS.tools}/${platform}/Updater.pak/launch.sh`;
		if (!(await pathExists(conn.adb, launchScript))) {
			throw new Error(`Updater.pak not found at ${launchScript}`);
		}

		// DashboardDeveloper.pak holds the pak slot (/tmp/next) while running,
		// which would cause launchPakNative to throw. The dashboard's local
		// stayAwakeActive flag can be stale (e.g. the pak was launched in a
		// prior session and the dashboard was reloaded), so always consult the
		// device: stopDevPak no-ops unless /tmp/stay_awake is present. If local
		// state also says active, use disableStayAwake so the UI updates too.
		if (isStayAwakeActive()) {
			adbLog.info('Stopping DashboardDeveloper.pak before launching Updater');
			await disableStayAwake();
		} else {
			await stopDevPak(conn.adb);
		}
		await waitForPakSlotFree(conn.adb);

		adbLog.info('Launching Updater.pak and disconnecting dashboard');
		await launchPakNative(conn.adb, launchScript);
	} catch (e) {
		const msg = formatError(e);
		adbLog.error(`Failed to launch Updater: ${msg}`);
		openUpdaterError = msg;
		openUpdaterBusy = false;
		return;
	}

	try {
		await disconnect();
	} catch (e) {
		adbLog.debug(`Disconnect after Updater launch: ${formatError(e)}`);
	} finally {
		openUpdaterBusy = false;
	}
}

export async function checkForDeviceUpdate(): Promise<void> {
	if (fetchStatus === 'fetching') return;
	dismissed = false;
	fetchStatus = 'fetching';
	try {
		const res = await fetch('https://api.github.com/repos/LoveRetro/NextUI/releases/latest');
		if (!res.ok) {
			fetchStatus = 'error';
			return;
		}
		const data = await res.json();
		const assets: { name: string }[] = data.assets ?? [];
		const match = assets
			.map((a) => a.name.match(/^(NextUI-\d{8}-\d+)/))
			.find((m) => m !== null);
		latestRelease = match ? match[1] : '';
		adbLog.info(`Latest NextUI release: ${latestRelease || '(not found)'}`);
		fetchStatus = 'done';
	} catch {
		fetchStatus = 'error';
	}
}
