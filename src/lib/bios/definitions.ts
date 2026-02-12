import { DEVICE_PATHS } from '$lib/adb/types.js';
import { getRomDirectoryName } from '$lib/roms/definitions.js';

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
	/**
	 * If true, only one of the files needs to be present (alternatives).
	 * Default is false (all files required).
	 */
	anyOneOf?: boolean;
	/** True if this system was discovered on the device rather than predefined */
	isCustom?: boolean;
}

/**
 * All BIOS systems and their files, ported from the original NextUI Setup Wizard.
 *
 * Source: NextUI-Setup-Wizard/Components/Pages/BiosConfig.razor lines 752-929
 * Extended with full system list from NextUI base install.
 */
/** Shared BIOS file data — referenced by multiple system codes to avoid hash duplication. */
const GBA_BIOS = {
	fileName: 'gba_bios.bin',
	sha1: '300c20df6731a33952ded8c436f7f186d25d3492',
	md5: 'a860e8c0b6d573d191e4ec7db1b1e4f6'
} as const;

const SEGA_CD_BIOS = [
	{ fileName: 'bios_CD_E.bin', sha1: 'f891e0ea651e2232af0c5c4cb46a0cae2ee8f356', md5: 'e66fa1dc5820d254611fdcdba0662372' },
	{ fileName: 'bios_CD_J.bin', sha1: '4846f448160059a7da0215a5df12ca160f26dd69', md5: '278a9397d192149e84e820ac621a8edd' },
	{ fileName: 'bios_CD_U.bin', sha1: 'f4f315adcef9b8feb0364c21ab7f0eaf5457f3ed', md5: '2efd74e3232ff260e371b99f84024f7f' }
] as const;

export const BIOS_SYSTEMS: BiosSystem[] = [
	{
		systemName: 'Amiga',
		systemCode: 'PUAE',
		files: [
			{
				fileName: 'kick34005.A500',
				systemCode: 'PUAE',
				sha1: '891e9a547772fe0c6c19b610baf8bc4ea7fcb785',
				md5: '82a21c1890cae844b3df741f2762d48d'
			},
			{
				fileName: 'kick40068.A1200',
				systemCode: 'PUAE',
				sha1: 'ef9194ab4804aa0aa8540d846caf291b28331165',
				md5: '646773759326fbac3b2311fd8c8793ee'
			}
		]
	},
	{
		systemName: 'Amstrad CPC',
		systemCode: 'CPC',
		files: [
			{
				fileName: 'cpc464.rom',
				systemCode: 'CPC',
				sha1: '56d39c463da60968d93e58b4ba0e675829412a20',
				md5: 'a993f85b88ac4350cf4d41554e87fe4f'
			},
			{
				fileName: 'cpc664.rom',
				systemCode: 'CPC',
				sha1: '073a7665527b5bd8a148747a3947dbd3328682c8',
				md5: '5a384a2310f472c7857888371c00ed66'
			},
			{
				fileName: 'cpc6128.rom',
				systemCode: 'CPC',
				sha1: '5977adbad3f7c1e0e082cd02fe76a700d9860c30',
				md5: 'b96280dc6c95a48857b4b8eb931533ae'
			},
			{
				fileName: 'cpc_amsdos.rom',
				systemCode: 'CPC',
				sha1: '39102c8e9cb55fcc0b9b62098780ed4a3cb6a4bb',
				md5: '25629dfe870d097469c217b95fdc1c95'
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
	},
	{
		systemName: 'Atari 2600',
		systemCode: 'A2600',
		files: []
	},
	{
		systemName: 'Atari 5200',
		systemCode: 'A5200',
		files: [
			{
				fileName: '5200.rom',
				systemCode: 'A5200',
				sha1: '6ad7a1e8c9fad486fbec9498cb48bf5bc3adc530',
				md5: '281f20ea4320404ec820fb7ec0693b38'
			}
		]
	},
	{
		systemName: 'Atari 7800',
		systemCode: 'A7800',
		files: [
			{
				fileName: '7800 BIOS (U).rom',
				systemCode: 'A7800',
				sha1: 'd9d134bb6b36907c615a594cc7688f7bfcef5b43',
				md5: '0763f1ffb006ddbe32e52d497ee848ae'
			}
		]
	},
	{
		systemName: 'Atari Lynx',
		systemCode: 'LYNX',
		files: [
			{
				fileName: 'lynxboot.img',
				systemCode: 'LYNX',
				sha1: 'e4ed47fae31693e016b081c6bda48da5b70d7ccb',
				md5: 'fcd403db69f54290b51035d82f835e7b'
			}
		]
	},
	{
		systemName: 'Colecovision',
		systemCode: 'COLECO',
		files: [
			{
				fileName: 'colecovision.rom',
				systemCode: 'COLECO',
				sha1: '45bedc4cbdeac66c7df59e9e599195c778d86a92',
				md5: '2c66f5911e5b42b8ebe113403548eee7'
			}
		]
	},
	{
		systemName: 'Commodore 128',
		systemCode: 'C128',
		files: [
			{
				fileName: 'JiffyDOS_C128.bin',
				systemCode: 'C128',
				sha1: '7fd2a28c4fdaeb140f3c8c8fb90271b1472c97b9',
				md5: 'cbbd1bbcb5e4fd8046b6030ab71fc021'
			},
			{
				fileName: 'JiffyDOS_C64.bin',
				systemCode: 'C128',
				sha1: '31e73e66eccb28732daea8ec3ad1addd9b39a017',
				md5: 'be09394f0576cf81fa8bacf634daf9a2'
			},
			{
				fileName: 'JiffyDOS_1541-II.bin',
				systemCode: 'C128',
				sha1: 'b1a5b826304d3df2a27d7163c6a81a532e040d32',
				md5: '1b1e985ea5325a1f46eb7fd9681707bf'
			}
		]
	},
	{
		systemName: 'Commodore 64',
		systemCode: 'C64',
		files: []
	},
	{
		systemName: 'Commodore PET',
		systemCode: 'PET',
		files: []
	},
	{
		systemName: 'Commodore Plus4',
		systemCode: 'PLUS4',
		files: []
	},
	{
		systemName: 'Commodore VIC20',
		systemCode: 'VIC',
		files: []
	},
	{
		systemName: 'Doom',
		systemCode: 'PRBOOM',
		files: [
			{
				fileName: 'prboom.wad',
				systemCode: 'PRBOOM',
				sha1: '5f4aed208301449c2e9514edfd325fe9dead76fa',
				md5: '72ae1b47820fcc93cc0fd9c428d0face'
			}
		]
	},
	{
		systemName: 'Famicom Disk System',
		systemCode: 'FDS',
		files: [
			{
				fileName: 'disksys.rom',
				systemCode: 'FDS',
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
		systemName: 'Game Boy Advance',
		systemCode: 'GBA / MGBA',
		files: [
			{ ...GBA_BIOS, systemCode: 'GBA' },
			{ ...GBA_BIOS, systemCode: 'MGBA' }
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
		systemName: 'Mega Drive / Genesis / Sega CD',
		systemCode: 'MD / SEGACD',
		files: [
			...SEGA_CD_BIOS.map((f) => ({ ...f, systemCode: 'MD' })),
			...SEGA_CD_BIOS.map((f) => ({ ...f, systemCode: 'SEGACD' }))
		]
	},
	{
		systemName: 'Microsoft MSX',
		systemCode: 'MSX',
		files: [
			{
				fileName: 'MSX.ROM',
				systemCode: 'MSX',
				sha1: '409e82adac40f6bdd18eb6c84e8b2fbdc7fb5498',
				md5: 'aa95aea2563cd5ec0a0919b44cc17d47'
			},
			{
				fileName: 'MSX2.ROM',
				systemCode: 'MSX',
				sha1: '6103b39f1e38d1aa2d84b1c3219c44f1abb5436e',
				md5: 'ec3a01c91f24fbddcbcab0ad301bc9ef'
			},
			{
				fileName: 'MSX2EXT.ROM',
				systemCode: 'MSX',
				sha1: '5c1f9c7fb655e43d38e5dd1fcc6b942b2ff68b02',
				md5: '2183c2aff17cf4297bdb496de78c2e8a'
			}
		]
	},
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
		systemName: 'Neo Geo Pocket',
		systemCode: 'NGP',
		files: []
	},
	{
		systemName: 'Neo Geo Pocket Color',
		systemCode: 'NGPC',
		files: []
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
		systemName: 'Pico-8',
		systemCode: 'P8',
		files: []
	},
	{
		systemName: 'Pokemon mini',
		systemCode: 'PKM',
		files: [
			{
				fileName: 'bios.min',
				systemCode: 'PKM',
				sha1: 'daad4113713ed776fbd47727762bca81ba74915f',
				md5: '1e4fb124a3a886865acb574f388c803d'
			}
		]
	},
	{
		systemName: 'Sega Game Gear',
		systemCode: 'GG',
		files: [
			{
				fileName: 'bios.gg',
				systemCode: 'GG',
				sha1: '914aa165e3d879f060be77870d345b60cfeb4ede',
				md5: '672e104c3be3a238301aceffc3b23fd6'
			}
		]
	},
	{
		systemName: 'Sega Master System',
		systemCode: 'SMS',
		files: [
			{
				fileName: 'bios.sms',
				systemCode: 'SMS',
				sha1: 'c315672807d8ddb8d91443729405c766dd95cae7',
				md5: '840481177270d5642a14ca71ee72844c'
			}
		]
	},
	{
		systemName: 'Sony PlayStation',
		systemCode: 'PS',
		anyOneOf: true,
		files: [
			{
				fileName: 'psxonpsp660.bin',
				systemCode: 'PS',
				sha1: '96880d1ca92a016ff054be5159bb06fe03cb4e14',
				md5: 'c53ca5908936d412331790f4426c6c33'
			},
			{
				fileName: 'scph5501.bin',
				systemCode: 'PS',
				sha1: '0555c6fae8906f3f09baf5988f00e55f88e9f30b',
				md5: '490f666e1afb15b7362b406ed1cea246'
			}
		]
	},
	{
		systemName: 'Super Game Boy',
		systemCode: 'SGB',
		files: [
			{
				fileName: 'SGB1.sfc',
				systemCode: 'SGB',
				sha1: '973e10840db683cf3faf61bd443090786b3a9f04',
				md5: 'b15ddb15721c657d82c5bab6db982ee9'
			},
			{
				fileName: 'SGB2.sfc',
				systemCode: 'SGB',
				sha1: 'e5b2922ca137051059e4269b236d07a22c07bc84',
				md5: '8ecd73eb4edf7ed7e81aef1be80031d5'
			}
		]
	},
	{
		systemName: 'Super Nintendo',
		systemCode: 'SFC',
		files: []
	},
	{
		systemName: 'Virtual Boy',
		systemCode: 'VB',
		files: []
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
		const romDirName = getRomDirectoryName(file.systemCode) ?? `${file.systemCode} (${file.systemCode})`;
		return `${DEVICE_PATHS.roms}/${romDirName}/${file.fileName}`;
	}
	return `${DEVICE_PATHS.bios}/${file.systemCode}/${file.fileName}`;
}

/** Get all unique BIOS file definitions (flattened from all systems) */
export function getAllBiosFiles(): BiosFileDefinition[] {
	return BIOS_SYSTEMS.flatMap((s) => s.files);
}

/** Get BIOS files for a specific system code */
export function getBiosFilesForSystem(systemCode: string): BiosFileDefinition[] {
	return getAllBiosFiles().filter((f) => f.systemCode === systemCode);
}
