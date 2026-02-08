import { connectWebUSB, disconnect as adbDisconnect } from '$lib/adb/connection.js';
import type { AdbConnection } from '$lib/adb/types.js';

/** Shared reactive connection state */
let connection: AdbConnection | null = $state(null);
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

	try {
		connection = await connectWebUSB();
		status = `Connected: ${connection.device.product ?? connection.device.serial}`;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		error = msg;
		status = 'Connection failed';
		connection = null;
	} finally {
		busy = false;
	}
}

export async function disconnect() {
	if (!connection) return;
	busy = true;
	try {
		await adbDisconnect(connection);
	} catch {
		// ignore disconnect errors
	}
	connection = null;
	status = 'Disconnected';
	error = '';
	busy = false;
}
