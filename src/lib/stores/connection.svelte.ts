import { connectWebUSB, disconnect as adbDisconnect } from '$lib/adb/connection.js';
import type { AdbConnection } from '$lib/adb/types.js';
import { verifyNextUIInstallation, shell } from '$lib/adb/file-ops.js';
import { detectDevice, parseMinUIEnv } from '$lib/adb/platform.js';
import { DEFAULT_BASE, setDeviceBasePath } from '$lib/adb/types.js';
import {
	isDevPakInstalled,
	installDevPak,
	launchDevPakNative,
	stopDevPak,
	isStayAwakeActive as checkStayAwakeFile,
	launchShow2Overlay,
	stopShow2,
	isStayAwakeSupported
} from '$lib/adb/stay-awake.js';
import { adbLog } from '$lib/stores/log.svelte.js';
import { formatError } from '$lib/utils.js';
import type { ShellCmd } from '$lib/adb/adb-utils.js';

/** Shared reactive connection state — use $state.raw to prevent deep proxy on Adb internals */
let connection: AdbConnection | null = $state.raw(null);
let status: string = $state('Disconnected');
let error: string = $state('');
let busy: boolean = $state(false);
let nextuiVersion: string = $state('');
let platform: string = $state('');
let ldLibraryPath: string = $state('');

/** Stay-awake state */
let stayAwakeSupported: boolean = $state(false);
let stayAwakeActive: boolean = $state(false);
let stayAwakePromptVisible: boolean = $state(false);
let stayAwakeBusy: boolean = $state(false);
let stayAwakeError: string = $state('');
let stayAwakePollController: AbortController | null = null;

const STAY_AWAKE_PREF_KEY = 'stayAwakePref';
const STAY_AWAKE_POLL_MS = 5000;

export function getConnection() {
	return connection;
}

export function getStatus() {
	return status;
}

export function getError() {
	return error;
}

export function isBusy() {
	return busy;
}

export function isConnected() {
	return connection !== null;
}

export function getNextUIVersion() {
	return nextuiVersion;
}

export function getPlatform() {
	return platform;
}

export function getLdLibraryPath() {
	return ldLibraryPath;
}

export function isStayAwakeActive() {
	return stayAwakeActive;
}

export function isStayAwakeBusy() {
	return stayAwakeBusy;
}

export function isStayAwakePromptShown() {
	return stayAwakePromptVisible;
}

export function getStayAwakeError() {
	return stayAwakeError;
}

export function dismissStayAwakeError() {
	stayAwakeError = '';
}

export function canStayAwake(): boolean {
	return stayAwakeSupported;
}

export function getStayAwakePref(): string | null {
	try {
		return localStorage.getItem(STAY_AWAKE_PREF_KEY);
	} catch {
		return null;
	}
}

function resetState() {
	stopStayAwakePolling();
	stayAwakeSupported = false;
	stayAwakeActive = false;
	stayAwakePromptVisible = false;
	stayAwakeError = '';
	connection = null;
	status = 'Disconnected';
	nextuiVersion = '';
	platform = '';
	ldLibraryPath = '';
	setDeviceBasePath(DEFAULT_BASE);
}

/** Start polling /tmp/stay_awake to detect when the pak exits (user pressed B or remote stop). */
function startStayAwakePolling(): void {
	stopStayAwakePolling();
	const controller = new AbortController();
	stayAwakePollController = controller;

	(async () => {
		while (!controller.signal.aborted) {
			await new Promise((r) => setTimeout(r, STAY_AWAKE_POLL_MS));
			if (controller.signal.aborted || !connection) break;
			try {
				const active = await checkStayAwakeFile(connection.adb);
				if (!active && stayAwakeActive) {
					adbLog.info('Stay-awake ended (pak exited on device)');
					// Clean up show2 overlay if it's still running
					await stopShow2(connection.adb);
					stayAwakeActive = false;
					stopStayAwakePolling();
				}
			} catch {
				// Connection may have dropped — polling will stop on disconnect
			}
		}
	})();
}

function stopStayAwakePolling(): void {
	stayAwakePollController?.abort();
	stayAwakePollController = null;
}

export async function enableStayAwake(): Promise<void> {
	if (!connection || stayAwakeActive || stayAwakeBusy) return;
	if (!platform) {
		stayAwakeError = 'Cannot enable stay-awake: device platform could not be detected.';
		adbLog.error(stayAwakeError);
		return;
	}
	stayAwakeBusy = true;
	stayAwakeError = '';
	try {
		// Check if Developer.pak is installed; install if not
		const installed = await isDevPakInstalled(connection.adb, platform);
		if (!installed) {
			adbLog.info('Developer.pak not found, installing...');
			await installDevPak(connection.adb, platform);
		}

		// Launch via native mechanism (writes /tmp/next, kills nextui.elf)
		await launchDevPakNative(connection.adb, platform);
		stayAwakeActive = true;
		startStayAwakePolling();
		adbLog.info('Stay awake enabled');

		// Launch show2.elf overlay with dashboard branding on top of Developer.pak
		try {
			await launchShow2Overlay(connection.adb, platform, ldLibraryPath);
		} catch (e) {
			adbLog.warn(`show2 overlay failed (non-fatal): ${formatError(e)}`);
		}
	} catch (e) {
		const msg = formatError(e);
		adbLog.error(`Stay-awake failed: ${msg}`);
		stayAwakeError = msg;
		stayAwakeActive = false;
		// Clear stored preference so the prompt reappears on next connect
		// instead of silently auto-failing repeatedly
		try {
			localStorage.removeItem(STAY_AWAKE_PREF_KEY);
		} catch {
			// localStorage may be unavailable
		}
	} finally {
		stayAwakeBusy = false;
	}
}

export async function disableStayAwake(): Promise<void> {
	if (stayAwakeBusy) return;
	stopStayAwakePolling();
	if (!connection || !stayAwakeActive) {
		stayAwakeActive = false;
		return;
	}
	stayAwakeBusy = true;
	try {
		await stopShow2(connection.adb);
		await stopDevPak(connection.adb);
		adbLog.info('Stay awake disabled');
	} catch (e) {
		adbLog.debug(`Stop stay-awake: ${formatError(e)}`);
	} finally {
		stayAwakeBusy = false;
		stayAwakeActive = false;
	}
}

export async function toggleStayAwake(): Promise<void> {
	if (stayAwakeActive) {
		await disableStayAwake();
	} else {
		const pref = getStayAwakePref();
		if (pref === 'always') {
			await enableStayAwake();
		} else {
			// No stored preference (first time, or cleared after failure) — show prompt
			stayAwakeError = '';
			stayAwakePromptVisible = true;
		}
	}
}

/**
 * Respond to the stay-awake prompt dialog.
 * @param answer 'yes' | 'yes-always' | 'no' | 'never'
 */
export async function respondToStayAwakePrompt(answer: 'yes' | 'yes-always' | 'no' | 'never'): Promise<void> {
	stayAwakePromptVisible = false;
	try {
		if (answer === 'yes-always') localStorage.setItem(STAY_AWAKE_PREF_KEY, 'always');
		else if (answer === 'never') localStorage.setItem(STAY_AWAKE_PREF_KEY, 'never');
	} catch {
		// localStorage may be unavailable
	}
	// 'no' — just dismiss for this session, don't persist
	if (answer === 'yes' || answer === 'yes-always') {
		await enableStayAwake(); // errors surfaced via stayAwakeError
	}
}

/**
 * Execute a typed shell command on the connected device.
 * Uses the active connection from the store — no need to pass `adb`.
 * Throws if not connected.
 */
export async function adbExec(cmd: ShellCmd): Promise<string> {
	if (!connection) throw new Error('Not connected');
	return shell(connection.adb, cmd.toString());
}

export async function connect() {
	if (busy) return;
	error = '';
	busy = true;
	status = 'Connecting...';
	adbLog.info('WebUSB connect requested');

	try {
		const conn = await connectWebUSB();
		const deviceName = conn.device.product ?? conn.device.serial;
		adbLog.info(`Connected to ${deviceName} (serial=${conn.device.serial})`);

		// Detect device platform and base path first — DEVICE_PATHS must be
		// set before verifyNextUIInstallation which reads paths like Bios/, Roms/.
		status = 'Detecting device...';
		const detection = await detectDevice(conn.adb);
		platform = detection.platform;
		adbLog.info(`Device platform: ${platform || '(unknown)'}`);

		if (platform) {
			const env = await parseMinUIEnv(conn.adb, platform, detection.basePath);
			setDeviceBasePath(env.sdcardPath);
			ldLibraryPath = env.ldLibraryPath;
		}

		// Verify this is a NextUI device (uses DEVICE_PATHS set above)
		status = 'Verifying NextUI...';
		const verify = await verifyNextUIInstallation(conn.adb);
		if (!verify.ok) {
			adbLog.error(`Not a NextUI device: ${verify.error}`);
			try {
				await adbDisconnect(conn);
			} catch {
				// ignore disconnect errors
			}
			error = `Not a NextUI device: ${verify.error}`;
			status = 'Connection failed';
			connection = null;
			return;
		}

		// Use version from MinUI.zip verification
		nextuiVersion = verify.version ?? 'Unknown';
		adbLog.info(`NextUI version: ${nextuiVersion}`);

		connection = conn;
		status = `Connected: ${deviceName}`;
		adbLog.info('NextUI installation verified');

		// Stay-awake: only offer if the platform has Developer.pak support
		stayAwakeSupported = platform ? await isStayAwakeSupported(platform) : false;
		if (stayAwakeSupported) {
			const pref = getStayAwakePref();
			if (pref === 'always') {
				await enableStayAwake();
			} else if (pref !== 'never') {
				stayAwakePromptVisible = true;
			}
		}

		// Listen for unexpected disconnection (e.g. device sleep, USB unplug)
		const onDisconnect = () => {
			if (connection === conn) {
				adbLog.warn('Device disconnected unexpectedly');
				resetState();
				error = 'Device disconnected';
			}
		};
		conn.adb.disconnected.then(onDisconnect, onDisconnect);
	} catch (e) {
		const msg = formatError(e);
		error = msg;
		status = 'Connection failed';
		connection = null;
		adbLog.error(`Connection failed: ${msg}`);
	} finally {
		busy = false;
	}
}

export async function disconnect() {
	if (!connection) return;
	busy = true;
	adbLog.info('Disconnecting...');
	try {
		// Disable stay-awake before closing transport
		await disableStayAwake();
		await adbDisconnect(connection);
		adbLog.info('Disconnected');
	} catch (e) {
		adbLog.warn(`Disconnect error (ignored): ${e}`);
	} finally {
		resetState();
		error = '';
		busy = false;
	}
}
