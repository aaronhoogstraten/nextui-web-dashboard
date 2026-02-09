import type { Adb } from '@yume-chan/adb';

/** Connection method available in the current browser */
export type ConnectionMethod = 'webusb' | 'websocket' | 'none';

/** Current state of the device connection */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

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
	connectionMethod: ConnectionMethod;
}

/** Base path for NextUI on TrimUI devices */
export const NEXTUI_BASE_PATH = '/mnt/SDCARD';

/** Standard paths on the NextUI device */
export const DEVICE_PATHS = {
	base: NEXTUI_BASE_PATH,
	bios: `${NEXTUI_BASE_PATH}/Bios`,
	roms: `${NEXTUI_BASE_PATH}/Roms`,
	userdata: `${NEXTUI_BASE_PATH}/.userdata`,
	logs: `${NEXTUI_BASE_PATH}/.userdata/logs`,
	system: `${NEXTUI_BASE_PATH}/.system`,
	versionFile: `${NEXTUI_BASE_PATH}/.system/version.txt`,
	overlays: `${NEXTUI_BASE_PATH}/Overlays`,
	minuiZip: `${NEXTUI_BASE_PATH}/MinUI.zip`
} as const;
