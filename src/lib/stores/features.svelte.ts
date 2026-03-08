import { FEATURE_FLAGS, type FeatureId } from '$lib/config/feature-flags.js';

const overrides = new Map<FeatureId, boolean>();
let version = $state(0);

export function isFeatureEnabled(id: string): boolean {
	void version; // subscribe to reactive updates
	const fid = id as FeatureId;
	if (!(fid in FEATURE_FLAGS)) return true;
	if (overrides.has(fid)) return overrides.get(fid)!;
	return FEATURE_FLAGS[fid];
}

export function enableFeature(id: FeatureId) {
	overrides.set(id, true);
	version++;
}

export function disableFeature(id: FeatureId) {
	overrides.set(id, false);
	version++;
}

export function resetFeatures() {
	overrides.clear();
	version++;
}

export function getFeatureFlags(): Record<FeatureId, boolean> {
	void version;
	const result = { ...FEATURE_FLAGS };
	for (const [id, val] of overrides) {
		result[id] = val;
	}
	return result;
}

// Register console API — usage:
//   window.__nextui.flags                    // inspect current state
//   window.__nextui.enableFeature('roms')    // override a disabled flag
//   window.__nextui.disableFeature('roms')   // disable for testing
//   window.__nextui.resetFeatures()          // clear all overrides
if (typeof window !== 'undefined') {
	(window as Window).__nextui = {
		get flags() {
			return getFeatureFlags();
		},
		enableFeature,
		disableFeature,
		resetFeatures,
	};
}
