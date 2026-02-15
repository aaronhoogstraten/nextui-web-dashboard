import { connectWebUSB, disconnect as adbDisconnect } from '$lib/adb/connection.js';
import type { AdbConnection } from '$lib/adb/types.js';
import { verifyNextUIInstallation, shell } from '$lib/adb/file-ops.js';
import { detectPlatform } from '$lib/adb/platform.js';
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

		// Listen for unexpected disconnection (e.g. device sleep, USB unplug)
		// The promise resolves on clean close, rejects on transport error (e.g. NetworkError)
		const onDisconnect = () => {
			if (connection === conn) {
				adbLog.warn('Device disconnected unexpectedly');
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
		await adbDisconnect(connection);
		adbLog.info('Disconnected');
	} catch (e) {
		adbLog.warn(`Disconnect error (ignored): ${e}`);
	} finally {
		connection = null;
		status = 'Disconnected';
		error = '';
		nextuiVersion = '';
		platform = '';
		busy = false;
	}
}
