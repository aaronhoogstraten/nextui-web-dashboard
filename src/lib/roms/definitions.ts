import { DEVICE_PATHS } from '$lib/adb/types.js';

/** A ROM system definition */
export interface RomSystem {
	/** Display name shown in the UI (e.g. "NES/Famicom") */
	systemName: string;
	/** System code used in folder names (e.g. "FC") */
	systemCode: string;
	/**
	 * Name used in the ROM folder path when different from systemName.
	 * e.g. FC uses "Nintendo Entertainment System" instead of "NES/Famicom"
	 */
	romPathSystemName?: string;
	/** Supported file extensions (lowercase, with dot) */
	supportedFormats: string[];
	/** True if this system was discovered on the device rather than predefined */
	isCustom?: boolean;
}

/**
 * All ROM systems, ported from the original NextUI Setup Wizard.
 *
 * Source: NextUI-Setup-Wizard/Components/Pages/RomConfig.razor lines 818-893
 * Extended with full system list from NextUI base install.
 */
export const ROM_SYSTEMS: RomSystem[] = [
	{
		systemName: 'Amiga',
		systemCode: 'PUAE',
		supportedFormats: ['.adf', '.ipf', '.dms', '.zip']
	},
	{
		systemName: 'Amstrad CPC',
		systemCode: 'CPC',
		supportedFormats: ['.dsk', '.sna', '.tap', '.cdt', '.zip']
	},
	{
		systemName: 'Arcade',
		systemCode: 'FBN',
		supportedFormats: ['.zip']
	},
	{
		systemName: 'Atari 2600',
		systemCode: 'A2600',
		supportedFormats: ['.a26', '.bin', '.zip']
	},
	{
		systemName: 'Atari 5200',
		systemCode: 'A5200',
		supportedFormats: ['.a52', '.bin', '.zip']
	},
	{
		systemName: 'Atari 7800',
		systemCode: 'A7800',
		supportedFormats: ['.a78', '.bin', '.zip']
	},
	{
		systemName: 'Atari Lynx',
		systemCode: 'LYNX',
		supportedFormats: ['.lnx', '.zip']
	},
	{
		systemName: 'Colecovision',
		systemCode: 'COLECO',
		supportedFormats: ['.col', '.rom', '.zip']
	},
	{
		systemName: 'Commodore 128',
		systemCode: 'C128',
		supportedFormats: ['.d64', '.d71', '.d80', '.d81', '.d82', '.g64', '.t64', '.tap', '.crt', '.zip']
	},
	{
		systemName: 'Commodore 64',
		systemCode: 'C64',
		supportedFormats: ['.d64', '.t64', '.tap', '.crt', '.prg', '.zip']
	},
	{
		systemName: 'Commodore PET',
		systemCode: 'PET',
		supportedFormats: ['.prg', '.d64', '.tap', '.zip']
	},
	{
		systemName: 'Commodore Plus4',
		systemCode: 'PLUS4',
		supportedFormats: ['.d64', '.prg', '.tap', '.zip']
	},
	{
		systemName: 'Commodore VIC20',
		systemCode: 'VIC',
		supportedFormats: ['.d64', '.prg', '.tap', '.crt', '.zip']
	},
	{
		systemName: 'Doom',
		systemCode: 'PRBOOM',
		supportedFormats: ['.wad', '.zip']
	},
	{
		systemName: 'Famicom Disk System',
		systemCode: 'FDS',
		supportedFormats: ['.fds', '.nes', '.zip']
	},
	{
		systemName: 'Game Boy',
		systemCode: 'GB',
		supportedFormats: ['.gb', '.zip']
	},
	{
		systemName: 'Game Boy Advance',
		systemCode: 'GBA',
		supportedFormats: ['.gba', '.zip']
	},
	{
		systemName: 'Game Boy Advance',
		systemCode: 'MGBA',
		romPathSystemName: 'Game Boy Advance',
		supportedFormats: ['.gba', '.zip']
	},
	{
		systemName: 'Game Boy Color',
		systemCode: 'GBC',
		supportedFormats: ['.gbc', '.gb', '.zip']
	},
	{
		systemName: 'Microsoft MSX',
		systemCode: 'MSX',
		supportedFormats: ['.rom', '.mx1', '.mx2', '.dsk', '.zip']
	},
	{
		systemName: 'NES/Famicom',
		systemCode: 'FC',
		romPathSystemName: 'Nintendo Entertainment System',
		supportedFormats: ['.nes', '.fds', '.zip']
	},
	{
		systemName: 'Neo Geo Pocket',
		systemCode: 'NGP',
		supportedFormats: ['.ngp', '.ngc', '.zip']
	},
	{
		systemName: 'Neo Geo Pocket Color',
		systemCode: 'NGPC',
		supportedFormats: ['.ngc', '.ngp', '.zip']
	},
	{
		systemName: 'PC Engine',
		systemCode: 'PCE',
		romPathSystemName: 'TurboGrafx-16',
		supportedFormats: ['.pce', '.cue', '.iso', '.chd', '.zip']
	},
	{
		systemName: 'Pico-8',
		systemCode: 'P8',
		supportedFormats: ['.p8', '.png']
	},
	{
		systemName: 'Pokemon mini',
		systemCode: 'PKM',
		romPathSystemName: 'Pokémon mini',
		supportedFormats: ['.min', '.zip']
	},
	{
		systemName: 'Sega 32X',
		systemCode: '32X',
		supportedFormats: ['.32x', '.bin', '.zip']
	},
	{
		systemName: 'Sega CD',
		systemCode: 'SEGACD',
		supportedFormats: ['.cue', '.iso', '.chd', '.zip']
	},
	{
		systemName: 'Sega Game Gear',
		systemCode: 'GG',
		supportedFormats: ['.gg', '.zip']
	},
	{
		systemName: 'Sega Genesis',
		systemCode: 'MD',
		supportedFormats: ['.md', '.gen', '.smd', '.zip']
	},
	{
		systemName: 'Sega Master System',
		systemCode: 'SMS',
		supportedFormats: ['.sms', '.zip']
	},
	{
		systemName: 'Sega SG-1000',
		systemCode: 'SG1000',
		supportedFormats: ['.sg', '.zip']
	},
	{
		systemName: 'SNES',
		systemCode: 'SFC',
		romPathSystemName: 'Super Nintendo Entertainment System',
		supportedFormats: ['.sfc', '.smc', '.zip']
	},
	{
		systemName: 'SNES',
		systemCode: 'SUPA',
		romPathSystemName: 'Super Nintendo Entertainment System',
		supportedFormats: ['.sfc', '.smc', '.zip']
	},
	{
		systemName: 'Sony PlayStation',
		systemCode: 'PS',
		supportedFormats: ['.cue', '.iso', '.chd', '.pbp', '.zip']
	},
	{
		systemName: 'Super Game Boy',
		systemCode: 'SGB',
		supportedFormats: ['.gb', '.gbc', '.zip']
	},
	{
		systemName: 'Virtual Boy',
		systemCode: 'VB',
		supportedFormats: ['.vb', '.vboy', '.zip']
	}
];

/** Set of all known ROM system codes — used for cross-module validation */
export const ROM_SYSTEM_CODES: ReadonlySet<string> = new Set(ROM_SYSTEMS.map((s) => s.systemCode));

// Dev-time assertion: ensure all system codes are unique
if (import.meta.env.DEV) {
	const codes = ROM_SYSTEMS.map((s) => s.systemCode);
	const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
	if (dupes.length > 0) console.error(`Duplicate ROM system codes: ${dupes.join(', ')}`);
}

/**
 * Get the device folder path for a ROM system.
 * Pattern: /mnt/SDCARD/Roms/{DisplayName} ({SystemCode})
 */
export function getRomDevicePath(system: RomSystem): string {
	const pathName = system.romPathSystemName ?? system.systemName;
	return `${DEVICE_PATHS.roms}/${pathName} (${system.systemCode})`;
}

/**
 * Get a ROM system by its system code.
 */
export function getRomSystem(systemCode: string): RomSystem | undefined {
	return ROM_SYSTEMS.find((s) => s.systemCode === systemCode);
}

/**
 * Get the .media directory path for a ROM system.
 * Pattern: /mnt/SDCARD/Roms/{DisplayName} ({SystemCode})/.media
 */
export function getRomMediaPath(system: RomSystem): string {
	return `${getRomDevicePath(system)}/.media`;
}

/**
 * Check if a file extension is valid for a given system.
 * Custom (device-discovered) systems accept any extension since their formats are unknown.
 * @param extension - File extension with dot (e.g. ".nes")
 * @param system - ROM system to check against
 */
export function isValidRomExtension(extension: string, system: RomSystem): boolean {
	if (system.isCustom) return true;
	return system.supportedFormats.includes(extension.toLowerCase());
}

/**
 * Get the ROM directory name for a system code (without the full device path).
 * Pattern: "{DisplayName} ({SystemCode})"
 * Returns null if the system code is not found in ROM_SYSTEMS.
 */
export function getRomDirectoryName(systemCode: string): string | null {
	const system = ROM_SYSTEMS.find((s) => s.systemCode === systemCode);
	if (!system) return null;
	const pathName = system.romPathSystemName ?? system.systemName;
	return `${pathName} (${system.systemCode})`;
}

/**
 * Parse a ROM directory name into systemName and systemCode.
 * Pattern: "{DisplayName} ({SystemCode})"
 * Uses the last parenthesized group so display names with parens are handled correctly.
 * Returns null if the name doesn't match the pattern.
 */
export function parseRomDirectoryName(
	dirName: string
): { systemName: string; systemCode: string } | null {
	const lastOpen = dirName.lastIndexOf(' (');
	if (lastOpen < 0) return null;
	const lastClose = dirName.indexOf(')', lastOpen);
	if (lastClose < 0 || lastClose !== dirName.length - 1) return null;
	const systemName = dirName.substring(0, lastOpen);
	const systemCode = dirName.substring(lastOpen + 2, lastClose);
	return systemCode ? { systemName, systemCode } : null;
}
