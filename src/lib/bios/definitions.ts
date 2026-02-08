import { DEVICE_PATHS } from '$lib/adb/types.js';

/** A single BIOS file definition */
export interface BiosFileDefinition {
	/** Filename on the device */
	fileName: string;
	/** System code directory (e.g. "GBA", "PS") */
	systemCode: string;
	/** Expected SHA-1 hash (lowercase hex) */
	sha1: string;
	/** Expected MD5 hash (lowercase hex) */
	md5: string;
	/**
	 * If true, this file goes in the Roms directory instead of Bios.
	 * e.g. neogeo.zip → /mnt/SDCARD/Roms/Arcade (FBN)/neogeo.zip
	 */
	isRomFile?: boolean;
}

/** A group of BIOS files for one emulation system */
export interface BiosSystem {
	/** Display name (e.g. "Game Boy Advance") */
	systemName: string;
	/** System code(s) shown in UI (e.g. "GBA / MGBA") */
	systemCode: string;
	/** BIOS files belonging to this system */
	files: BiosFileDefinition[];
}

/**
 * All BIOS systems and their files, ported from the original NextUI Setup Wizard.
 *
 * Source: NextUI-Setup-Wizard/Components/Pages/BiosConfig.razor lines 752-929
 */
export const BIOS_SYSTEMS: BiosSystem[] = [
	{
		systemName: 'NES/Famicom',
		systemCode: 'FC',
		files: [
			{
				fileName: 'disksys.rom',
				systemCode: 'FC',
				sha1: '57fe1bdee955bb48d357e463ccbf129496930b62',
				md5: 'ca30b50f880eb660a320674ed365ef7a'
			}
		]
	},
	{
		systemName: 'Game Boy',
		systemCode: 'GB',
		files: [
			{
				fileName: 'gb_bios.bin',
				systemCode: 'GB',
				sha1: '4ed31ec6b0b175bb109c0eb5fd3d193da823339f',
				md5: '32fbbd84168d3482956eb3c5051637f5'
			}
		]
	},
	{
		systemName: 'Game Boy Color',
		systemCode: 'GBC',
		files: [
			{
				fileName: 'gbc_bios.bin',
				systemCode: 'GBC',
				sha1: '1293d68bf9643bc4f36954c1e80e38f39864528d',
				md5: 'dbfce9db9deaa2567f6a84fde55f9680'
			}
		]
	},
	{
		systemName: 'Game Boy Advance',
		systemCode: 'GBA / MGBA',
		files: [
			{
				fileName: 'gba_bios.bin',
				systemCode: 'GBA',
				sha1: '300c20df6731a33952ded8c436f7f186d25d3492',
				md5: 'a860e8c0b6d573d191e4ec7db1b1e4f6'
			},
			{
				fileName: 'gba_bios.bin',
				systemCode: 'MGBA',
				sha1: '300c20df6731a33952ded8c436f7f186d25d3492',
				md5: 'a860e8c0b6d573d191e4ec7db1b1e4f6'
			}
		]
	},
	{
		systemName: 'Mega Drive / Genesis / Sega CD',
		systemCode: 'MD / Sega CD',
		files: [
			{
				fileName: 'bios_CD_E.bin',
				systemCode: 'MD',
				sha1: 'f891e0ea651e2232af0c5c4cb46a0cae2ee8f356',
				md5: 'e66fa1dc5820d254611fdcdba0662372'
			},
			{
				fileName: 'bios_CD_J.bin',
				systemCode: 'MD',
				sha1: '4846f448160059a7da0215a5df12ca160f26dd69',
				md5: '278a9397d192149e84e820ac621a8edd'
			},
			{
				fileName: 'bios_CD_U.bin',
				systemCode: 'MD',
				sha1: 'f4f315adcef9b8feb0364c21ab7f0eaf5457f3ed',
				md5: '2efd74e3232ff260e371b99f84024f7f'
			},
			{
				fileName: 'bios_CD_E.bin',
				systemCode: 'SEGACD',
				sha1: 'f891e0ea651e2232af0c5c4cb46a0cae2ee8f356',
				md5: 'e66fa1dc5820d254611fdcdba0662372'
			},
			{
				fileName: 'bios_CD_J.bin',
				systemCode: 'SEGACD',
				sha1: '4846f448160059a7da0215a5df12ca160f26dd69',
				md5: '278a9397d192149e84e820ac621a8edd'
			},
			{
				fileName: 'bios_CD_U.bin',
				systemCode: 'SEGACD',
				sha1: 'f4f315adcef9b8feb0364c21ab7f0eaf5457f3ed',
				md5: '2efd74e3232ff260e371b99f84024f7f'
			}
		]
	},
	{
		systemName: 'PC Engine',
		systemCode: 'PCE',
		files: [
			{
				fileName: 'syscard3.pce',
				systemCode: 'PCE',
				sha1: '79f5ff55dd10187c7fd7b8daab0b3ffbd1f56a2c',
				md5: '38179df8f4ac870017db21ebcbf53114'
			}
		]
	},
	{
		systemName: 'Sony PlayStation',
		systemCode: 'PS',
		files: [
			{
				fileName: 'psxonpsp660.bin',
				systemCode: 'PS',
				sha1: '96880d1ca92a016ff054be5159bb06fe03cb4e14',
				md5: 'c53ca5908936d412331790f4426c6c33'
			}
		]
	},
	{
		systemName: 'Arcade',
		systemCode: 'FBN',
		files: [
			{
				fileName: 'neogeo.zip',
				systemCode: 'FBN',
				sha1: 'deb62b0074b8cae4f162c257662136733cfc76ad',
				md5: '00dad01abdbf8ea9e79ad2fe11bdb182',
				isRomFile: true
			}
		]
	}
];

/**
 * Get the device path where a BIOS file should be stored.
 *
 * Standard BIOS files go to: /mnt/SDCARD/Bios/{systemCode}/{fileName}
 * ROM-type BIOS files (e.g. neogeo.zip) go to: /mnt/SDCARD/Roms/{romDirName}/{fileName}
 */
export function getBiosDevicePath(file: BiosFileDefinition): string {
	if (file.isRomFile) {
		const romDirName = getRomDirectoryName(file.systemCode);
		return `${DEVICE_PATHS.roms}/${romDirName}/${file.fileName}`;
	}
	return `${DEVICE_PATHS.bios}/${file.systemCode}/${file.fileName}`;
}

/**
 * Get the ROM directory name for a system code.
 * Matches the naming convention: "Display Name (CODE)"
 */
function getRomDirectoryName(systemCode: string): string {
	const nameMap: Record<string, string> = {
		FBN: 'Arcade'
	};
	const displayName = nameMap[systemCode] ?? systemCode;
	return `${displayName} (${systemCode})`;
}

/** Get all unique BIOS file definitions (flattened from all systems) */
export function getAllBiosFiles(): BiosFileDefinition[] {
	return BIOS_SYSTEMS.flatMap((s) => s.files);
}

/** Get BIOS files for a specific system code */
export function getBiosFilesForSystem(systemCode: string): BiosFileDefinition[] {
	return getAllBiosFiles().filter((f) => f.systemCode === systemCode);
}
