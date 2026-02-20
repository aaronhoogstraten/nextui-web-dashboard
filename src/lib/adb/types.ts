import type { Adb } from '@yume-chan/adb';

/** Information about the connected device */
export interface DeviceInfo {
	serial: string;
	product?: string;
	model?: string;
	transportId?: string;
}

/** Storage capacity information from the device */
export interface StorageInfo {
	totalBytes: number;
	usedBytes: number;
	availableBytes: number;
}

/** Result of a directory listing entry */
export interface DirectoryEntry {
	name: string;
	size: bigint;
	isDirectory: boolean;
	isFile: boolean;
	mtime: bigint;
}

/** Holds the active ADB connection and metadata */
export interface AdbConnection {
	adb: Adb;
	device: DeviceInfo;
	connectionMethod: 'webusb';
}

/** Default base path — overridden at connection time via detectDevice() in platform.ts. */
export const DEFAULT_BASE = '/mnt/SDCARD';

/** Standard paths on the NextUI device. */
export interface DevicePaths {
	base: string;
	bios: string;
	roms: string;
	userdata: string;
	logs: string;
	system: string;
	versionFile: string;
	emus: string;
	overlays: string;
	cheats: string;
	collections: string;
	screenshots: string;
	tools: string;
	minuiZip: string;
}

/** Build a DevicePaths object from a base SD card path. */
export function buildDevicePaths(basePath: string): DevicePaths {
	return {
		base: basePath,
		bios: `${basePath}/Bios`,
		roms: `${basePath}/Roms`,
		userdata: `${basePath}/.userdata`,
		logs: `${basePath}/.userdata/logs`,
		system: `${basePath}/.system`,
		versionFile: `${basePath}/.system/version.txt`,
		emus: `${basePath}/Emus`,
		overlays: `${basePath}/Overlays`,
		cheats: `${basePath}/Cheats`,
		collections: `${basePath}/Collections`,
		screenshots: `${basePath}/Screenshots`,
		tools: `${basePath}/Tools`,
		minuiZip: `${basePath}/MinUI.zip`
	};
}

/**
 * Device paths, populated at connection time from MinUI.pak/launch.sh.
 * Initialized with bootstrap defaults; updated via setDeviceBasePath().
 */
// eslint-disable-next-line import/no-mutable-exports
export let DEVICE_PATHS: DevicePaths = buildDevicePaths(DEFAULT_BASE);

/** Update DEVICE_PATHS to use a new base path (called after reading launch.sh). */
export function setDeviceBasePath(basePath: string): void {
	DEVICE_PATHS = buildDevicePaths(basePath);
}
