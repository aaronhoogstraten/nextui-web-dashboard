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
}

/**
 * All ROM systems, ported from the original NextUI Setup Wizard.
 *
 * Source: NextUI-Setup-Wizard/Components/Pages/RomConfig.razor lines 818-893
 */
export const ROM_SYSTEMS: RomSystem[] = [
	{
		systemName: 'NES/Famicom',
		systemCode: 'FC',
		romPathSystemName: 'Nintendo Entertainment System',
		supportedFormats: ['.nes', '.fds', '.zip']
	},
	{
		systemName: 'SNES',
		systemCode: 'SUPA',
		romPathSystemName: 'Super Nintendo Entertainment System',
		supportedFormats: ['.sfc', '.smc', '.zip']
	},
	{
		systemName: 'Game Boy',
		systemCode: 'GB',
		supportedFormats: ['.gb', '.zip']
	},
	{
		systemName: 'Game Boy Color',
		systemCode: 'GBC',
		supportedFormats: ['.gbc', '.gb', '.zip']
	},
	{
		systemName: 'Game Boy Advance',
		systemCode: 'GBA',
		supportedFormats: ['.gba', '.zip']
	},
	{
		systemName: 'Sega Mega Drive / Sega Genesis',
		systemCode: 'MD',
		romPathSystemName: 'Sega Genesis',
		supportedFormats: ['.md', '.gen', '.smd', '.zip']
	},
	{
		systemName: 'Sega CD',
		systemCode: 'SEGACD',
		supportedFormats: ['.cue', '.iso', '.chd', '.zip']
	},
	{
		systemName: 'PC Engine',
		systemCode: 'PCE',
		supportedFormats: ['.pce', '.cue', '.iso', '.chd', '.zip']
	},
	{
		systemName: 'Sony PlayStation',
		systemCode: 'PS',
		supportedFormats: ['.cue', '.iso', '.chd', '.pbp', '.zip']
	},
	{
		systemName: 'Arcade',
		systemCode: 'FBN',
		supportedFormats: ['.zip']
	}
];

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
 * @param extension - File extension with dot (e.g. ".nes")
 * @param system - ROM system to check against
 */
export function isValidRomExtension(extension: string, system: RomSystem): boolean {
	return system.supportedFormats.includes(extension.toLowerCase());
}
