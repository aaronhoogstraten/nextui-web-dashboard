import type { Adb } from '@yume-chan/adb';
import type { RomSystem } from '$lib/roms/definitions.js';

export interface RomOverviewSystem {
	system: RomSystem;
	devicePath: string;
	romCount: number | null;
	error: string;
}

/** The result of a full scan of the device, as shown by the ROM systems list. */
export interface RomOverview {
	availableEmus: Set<string>;
	systems: RomOverviewSystem[];
}

/**
 * Last ROM systems scan, shown straight away when the view reopens while a new
 * scan corrects it, so it never needs invalidating. Each connection has its own
 * `Adb`, so a reconnect (or another device or card) starts empty.
 */
const romOverviews = new WeakMap<Adb, RomOverview>();

export function getRomOverview(adb: Adb): RomOverview | undefined {
	return romOverviews.get(adb);
}

export function saveRomOverview(adb: Adb, overview: RomOverview): void {
	romOverviews.set(adb, overview);
}

/**
 * Keep the scan in step with a change the ROM view made or observed itself.
 * The count comes from a successful read, which settles any earlier error.
 */
export function updateRomOverviewCount(adb: Adb, devicePath: string, romCount: number): void {
	const entry = romOverviews.get(adb)?.systems.find((s) => s.devicePath === devicePath);
	if (entry) {
		entry.romCount = romCount;
		entry.error = '';
	}
}
