export type FeatureId =
	| 'roms'
	| 'bios'
	| 'saves'
	| 'overlays'
	| 'cheats'
	| 'collections'
	| 'screenshots'
	| 'palettes'
	| 'files'
	| 'logs'
	| 'adb-shell';

export const FEATURE_FLAGS: Record<FeatureId, boolean> = {
	roms: true,
	bios: true,
	saves: true,
	overlays: true,
	cheats: true,
	collections: true,
	screenshots: true,
	palettes: true,
	files: true,
	logs: true,
	'adb-shell': false
};
