import { connectWebUSB, disconnect as adbDisconnect } from '$lib/adb/connection.js';
import type { AdbConnection } from '$lib/adb/types.js';
import { verifyNextUIInstallation, shell } from '$lib/adb/file-ops.js';
import { detectPlatform } from '$lib/adb/platform.js';
import {
	isDevPakInstalled,
	installDevPak,
	launchDevPakNative,
	stopDevPak,
	isStayAwakeActive as checkStayAwakeFile,
	launchShow2Overlay,
	stopShow2
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

/** Stay-awake state */
let stayAwakeActive: boolean = $state(false);
let stayAwakePromptVisible: boolean = $state(false);
let stayAwakeBusy: boolean = $state(false);
let stayAwakeError: string = $state('');
let stayAwakePollInterval: ReturnType<typeof setInterval> | null = null;

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

export function getStayAwakePref(): string | null {
	try {
		return localStorage.getItem(STAY_AWAKE_PREF_KEY);
	} catch {
		return null;
	}
}

/** Start polling /tmp/stay_awake to detect when the pak exits (user pressed B or remote stop). */
function startStayAwakePolling(): void {
	stopStayAwakePolling();
	stayAwakePollInterval = setInterval(async () => {
		if (!connection) {
			stopStayAwakePolling();
			return;
		}
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
	}, STAY_AWAKE_POLL_MS);
}

function stopStayAwakePolling(): void {
	if (stayAwakePollInterval !== null) {
		clearInterval(stayAwakePollInterval);
		stayAwakePollInterval = null;
	}
}

export async function enableStayAwake(): Promise<void> {
	if (!connection || stayAwakeActive || stayAwakeBusy) return;
	if (!platform) {
		stayAwakeError = 'Cannot enable stay-awake: device platform could not be detected.';
		adbLog.error(stayAwakeError);
		return;
	}
	stayAwakeBusy = true;
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
			await launchShow2Overlay(connection.adb, platform);
		} catch (e) {
			adbLog.warn(`show2 overlay failed (non-fatal): ${formatError(e)}`);
		}
	} catch (e) {
		const msg = formatError(e);
		adbLog.error(`Stay-awake failed: ${msg}`);
		stayAwakeError = msg;
		stayAwakeActive = false;
	} finally {
		stayAwakeBusy = false;
	}
}

export async function disableStayAwake(): Promise<void> {
	stopStayAwakePolling();
	if (!connection || !stayAwakeActive) {
		stayAwakeActive = false;
		return;
	}
	try {
		await stopShow2(connection.adb);
		await stopDevPak(connection.adb);
		adbLog.info('Stay awake disabled');
	} catch (e) {
		adbLog.debug(`Stop stay-awake: ${formatError(e)}`);
	}
	stayAwakeActive = false;
}

export async function toggleStayAwake(): Promise<void> {
	if (stayAwakeActive) {
		await disableStayAwake();
	} else {
		await enableStayAwake();
	}
}

/**
 * Respond to the stay-awake prompt dialog.
 * @param answer 'yes' | 'yes-always' | 'no' | 'never'
 */
export async function respondToStayAwakePrompt(answer: 'yes' | 'yes-always' | 'no' | 'never'): Promise<void> {
	stayAwakePromptVisible = false;
	try {
		if (answer === 'yes-always') {
			localStorage.setItem(STAY_AWAKE_PREF_KEY, 'always');
			await enableStayAwake();
		} else if (answer === 'yes') {
			await enableStayAwake();
		} else if (answer === 'never') {
			localStorage.setItem(STAY_AWAKE_PREF_KEY, 'never');
		}
		// 'no' — just dismiss for this session, don't persist
	} catch {
		// localStorage may be unavailable
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

		// Verify this is a NextUI device
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

		// Detect device platform
		platform = await detectPlatform(conn.adb);
		adbLog.info(`Device platform: ${platform || '(unknown)'}`);

		connection = conn;
		status = `Connected: ${deviceName}`;
		adbLog.info('NextUI installation verified');

		// Stay-awake: check user preference
		if (platform) {
			const pref = getStayAwakePref();
			if (pref === 'always') {
				enableStayAwake();
			} else if (pref !== 'never') {
				stayAwakePromptVisible = true;
			}
		}

		// Listen for unexpected disconnection (e.g. device sleep, USB unplug)
		const onDisconnect = () => {
			if (connection === conn) {
				adbLog.warn('Device disconnected unexpectedly');
				stopStayAwakePolling();
				stayAwakeActive = false;
				stayAwakePromptVisible = false;
				connection = null;
				status = 'Disconnected';
				error = 'Device disconnected';
				nextuiVersion = '';
				platform = '';
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
		stopStayAwakePolling();
		stayAwakeActive = false;
		stayAwakePromptVisible = false;
		connection = null;
		status = 'Disconnected';
		error = '';
		nextuiVersion = '';
		platform = '';
		busy = false;
	}
}
