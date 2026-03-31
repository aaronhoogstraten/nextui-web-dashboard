export type FeatureId = 'roms' | 'bios' | 'overlays' | 'cheats' | 'collections' | 'screenshots' | 'files' | 'logs' | 'adb-shell';

export const FEATURE_FLAGS: Record<FeatureId, boolean> = {
	roms: true,
	bios: true,
	overlays: true,
	cheats: true,
	collections: true,
	screenshots: true,
	files: true,
	logs: true,
	'adb-shell': false,
};
