import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import type { AdbConnection, DeviceInfo } from './types.js';

/** Cached credential store instance (persists RSA keys in IndexedDB) */
let credentialStore: AdbWebCredentialStore | null = null;

function getCredentialStore(): AdbWebCredentialStore {
	if (!credentialStore) {
		credentialStore = new AdbWebCredentialStore('NextUI Web Dashboard');
	}
	return credentialStore;
}

/** Check if WebUSB is supported in the current browser */
export function hasWebUSB(): boolean {
	return typeof navigator !== 'undefined' && 'usb' in navigator;
}

/** Get a user-facing recommendation based on browser capabilities */
export function getBrowserRecommendation(): string {
	if (typeof navigator === 'undefined') return '';

	const ua = navigator.userAgent;

	if (ua.includes('Firefox')) {
		return 'Firefox does not support WebUSB. Please use Chrome or Edge.';
	}

	if (ua.includes('Safari') && !ua.includes('Chrome')) {
		return 'Safari does not support WebUSB. Please use Chrome or Edge.';
	}

	return '';
}

/**
 * Connect to a device via WebUSB.
 *
 * This prompts the user to select a USB device via the browser's device picker,
 * then authenticates and returns an active ADB connection.
 *
 * @throws Error if WebUSB is not supported or the user cancels device selection
 */
export async function connectWebUSB(): Promise<AdbConnection> {
	if (!('usb' in navigator)) {
		throw new Error('WebUSB is not supported in this browser');
	}

	const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
	if (!manager) {
		throw new Error('WebUSB device manager is not available');
	}

	// Prompt user to select a device
	const device = await manager.requestDevice();
	if (!device) {
		throw new Error('No device selected');
	}

	// Open USB connection
	const connection = await device.connect();

	// Authenticate (NextUI devices are Linux-based, may not need RSA auth,
	// but we provide credentials in case they do)
	const transport = await AdbDaemonTransport.authenticate({
		serial: device.serial,
		connection,
		credentialStore: getCredentialStore()
	});

	const adb = new Adb(transport);

	const deviceInfo: DeviceInfo = {
		serial: device.serial,
		product: device.name || undefined
	};

	return {
		adb,
		device: deviceInfo,
		connectionMethod: 'webusb'
	};
}

/**
 * Disconnect from the device and clean up resources.
 */
export async function disconnect(conn: AdbConnection): Promise<void> {
	await conn.adb.close();
}
