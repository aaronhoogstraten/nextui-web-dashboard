import { FEATURE_FLAGS, type FeatureId } from '$lib/config/feature-flags.js';

const STORAGE_KEY = 'nextuiFeatureOverrides';
// Only these flags may outlive the session, and only when the caller opts in.
const PERSISTABLE_FEATURES: readonly FeatureId[] = ['adb-shell'];

const overrides = new Map<FeatureId, boolean>(loadOverrides());
let version = $state(0);

function readStored(): Record<string, unknown> {
	if (typeof window === 'undefined') return {};
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function loadOverrides(): [FeatureId, boolean][] {
	const stored = readStored();
	return PERSISTABLE_FEATURES.filter((id) => typeof stored[id] === 'boolean').map((id) => [
		id,
		stored[id] as boolean
	]);
}

/**
 * Read-modify-write a single key. Rewriting the whole blob would let one tab's
 * stale snapshot erase a choice another tab made after this one loaded.
 */
function persistOverride(id: FeatureId, value: boolean | null) {
	if (typeof window === 'undefined') return;
	try {
		const stored = readStored();
		if (value === null) delete stored[id];
		else stored[id] = value;
		if (Object.keys(stored).length === 0) {
			localStorage.removeItem(STORAGE_KEY);
		} else {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
		}
	} catch {
		// localStorage may be unavailable
	}
}

export function isFeatureEnabled(id: string): boolean {
	void version; // subscribe to reactive updates
	const fid = id as FeatureId;
	if (!(fid in FEATURE_FLAGS)) return true;
	if (overrides.has(fid)) return overrides.get(fid)!;
	return FEATURE_FLAGS[fid];
}

/**
 * Override a flag for this session. `persist` additionally carries the override
 * across reloads, and is honoured only for PERSISTABLE_FEATURES — pass it only
 * where the user has explicitly asked for the choice to be remembered.
 */
export function setFeature(id: FeatureId, enabled: boolean, opts: { persist?: boolean } = {}) {
	overrides.set(id, enabled);
	if (PERSISTABLE_FEATURES.includes(id)) {
		// Turning a flag off always drops its stored copy; turning one on records it
		// only when asked, so an unremembered unlock lapses with the session.
		if (!enabled) persistOverride(id, null);
		else if (opts.persist) persistOverride(id, true);
	}
	version++;
}

/** Session-only unlock — see setFeature() to make a choice stick. */
export function enableFeature(id: FeatureId) {
	setFeature(id, true);
}

export function disableFeature(id: FeatureId) {
	setFeature(id, false);
}

export function resetFeatures() {
	overrides.clear();
	if (typeof window !== 'undefined') {
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch {
			// localStorage may be unavailable
		}
	}
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
		resetFeatures
	};

	Object.defineProperty(window, 'thisisunsafe', {
		get() {
			enableFeature('adb-shell');
			return 'ADB Console unlocked for this session. Look for the Shell toggle in the Console panel.';
		},
		configurable: true
	});
}
