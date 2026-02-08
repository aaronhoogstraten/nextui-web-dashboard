import { connectWebUSB, disconnect as adbDisconnect } from '$lib/adb/connection.js';
import type { AdbConnection } from '$lib/adb/types.js';
import { adbLog } from '$lib/stores/log.svelte.js';

/** Shared reactive connection state — use $state.raw to prevent deep proxy on Adb internals */
let connection: AdbConnection | null = $state.raw(null);
let status: string = $state('Disconnected');
let error: string = $state('');
let busy: boolean = $state(false);

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

export async function connect() {
	error = '';
	busy = true;
	status = 'Connecting...';
	adbLog.info('WebUSB connect requested');

	try {
		connection = await connectWebUSB();
		status = `Connected: ${connection.device.product ?? connection.device.serial}`;
		adbLog.info(`Connected to ${connection.device.product ?? connection.device.serial} (serial=${connection.device.serial})`);
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
	busy = false;
}
