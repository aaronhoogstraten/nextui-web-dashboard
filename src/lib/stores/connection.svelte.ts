import type { AdbSocket } from '@yume-chan/adb';
import { connectWebUSB, disconnect as adbDisconnect } from '$lib/adb/connection.js';
import type { AdbConnection } from '$lib/adb/types.js';
import { verifyNextUIInstallation, shell } from '$lib/adb/file-ops.js';
import { detectPlatform } from '$lib/adb/platform.js';
import { isDevPakInstalled, installDevPak, launchDevPak, stopStayAwake } from '$lib/adb/stay-awake.js';
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
let stayAwakeSocket: AdbSocket | null = null;
let stayAwakeActive: boolean = $state(false);
let stayAwakePromptVisible: boolean = $state(false);
let stayAwakeBusy: boolean = $state(false);

const STAY_AWAKE_PREF_KEY = 'stayAwakePref';

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

export function getStayAwakePref(): string | null {
	try {
		return localStorage.getItem(STAY_AWAKE_PREF_KEY);
	} catch {
		return null;
	}
}

export async function enableStayAwake(): Promise<void> {
	if (!connection || stayAwakeActive || stayAwakeBusy) return;
	if (!platform) {
		adbLog.warn('Cannot enable stay-awake: platform unknown');
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

		// Launch the pak
		stayAwakeSocket = await launchDevPak(connection.adb, platform);
		stayAwakeActive = true;
		adbLog.info('Stay awake enabled');
	} catch (e) {
		adbLog.error(`Stay-awake failed: ${formatError(e)}`);
		stayAwakeSocket = null;
		stayAwakeActive = false;
	} finally {
		stayAwakeBusy = false;
	}
}

export async function disableStayAwake(): Promise<void> {
	if (!stayAwakeSocket) {
		stayAwakeActive = false;
		return;
	}
	await stopStayAwake(stayAwakeSocket);
	stayAwakeSocket = null;
	stayAwakeActive = false;
	adbLog.info('Stay awake disabled');
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
		// The promise resolves on clean close, rejects on transport error (e.g. NetworkError)
		const onDisconnect = () => {
			if (connection === conn) {
				adbLog.warn('Device disconnected unexpectedly');
				// Clear stay-awake state (device-side cleanup happens via shell trap)
				stayAwakeSocket = null;
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
		stayAwakeSocket = null;
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
