import { connectWebUSB, disconnect as adbDisconnect } from '$lib/adb/connection.js';
import type { AdbConnection } from '$lib/adb/types.js';
import { DEVICE_PATHS } from '$lib/adb/types.js';
import { verifyNextUIInstallation, pullFile } from '$lib/adb/file-ops.js';
import { adbLog } from '$lib/stores/log.svelte.js';

/** Shared reactive connection state — use $state.raw to prevent deep proxy on Adb internals */
let connection: AdbConnection | null = $state.raw(null);
let status: string = $state('Disconnected');
let error: string = $state('');
let busy: boolean = $state(false);
let nextuiVersion: string = $state('');

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

export async function connect() {
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

		// Read NextUI version
		try {
			const versionData = await pullFile(conn.adb, DEVICE_PATHS.versionFile);
			nextuiVersion = new TextDecoder().decode(versionData).trim();
			adbLog.info(`NextUI version: ${nextuiVersion}`);
		} catch {
			nextuiVersion = 'Unknown';
			adbLog.warn('Could not read NextUI version file');
		}

		connection = conn;
		status = `Connected: ${deviceName}`;
		adbLog.info('NextUI installation verified');
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
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
	}
	connection = null;
	status = 'Disconnected';
	error = '';
	nextuiVersion = '';
	busy = false;
}
