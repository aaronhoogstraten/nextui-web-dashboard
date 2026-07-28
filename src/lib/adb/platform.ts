import type { Adb } from '@yume-chan/adb';
import { shell, pathExists } from './file-ops.js';
import { DEFAULT_BASE } from './types.js';
import { adbLog } from '$lib/stores/log.svelte.js';

/** Result of device detection — platform identifier and SD card mount path. */
export interface DeviceDetection {
	platform: string;
	basePath: string;
}

/**
 * Detect the device platform and SD card base path.
 *
 * Primary method: `lsof` inspects open files to find paths under `.system/`,
 * yielding both the mount point and platform in a single shell call.
 *
 * Fallback: cpuinfo detection script (matches NextUI's updater logic) for
 * platform only; base path defaults to DEFAULT_BASE.
 *
 * Returns platform string (e.g. "tg5040") and basePath (e.g. "/mnt/SDCARD").
 * Platform may be empty string if all detection methods fail.
 */
export async function detectDevice(adb: Adb): Promise<DeviceDetection> {
	// Primary: lsof (gets both platform and base path in one call)
	const lsofResult = await detectFromLsof(adb);
	if (lsofResult) return lsofResult;

	// Fallback: cpuinfo for platform, DEFAULT_BASE for path
	adbLog.warn('lsof detection failed, falling back to cpuinfo');
	const platform = await detectFromCpuinfo(adb);
	return { platform, basePath: DEFAULT_BASE };
}

/**
 * Detect platform and base path by inspecting open files via lsof.
 * Looks for any open file under a `.system/` directory, then extracts the
 * mount point (everything before `.system/`) and platform (first path
 * component after `.system/`).
 */
async function detectFromLsof(adb: Adb): Promise<DeviceDetection | null> {
	const script = `lsof | awk '$NF ~ /\\/.system\\// { split($NF,a,"/.system/"); split(a[2],b,"/"); print "MOUNT=" a[1]; print "PLATFORM=" b[1]; exit }'`;
	try {
		const output = await shell(adb, script);
		const lines = output.split('\n').map((l) => l.trim());

		let basePath = '';
		let platform = '';
		for (const line of lines) {
			if (line.startsWith('MOUNT=')) basePath = line.slice(6);
			else if (line.startsWith('PLATFORM=')) platform = line.slice(9);
		}

		if (platform && basePath) {
			adbLog.info(`lsof detection: platform=${platform}, basePath=${basePath}`);
			return { platform, basePath };
		}
	} catch (e) {
		adbLog.warn(`lsof detection failed: ${e}`);
	}
	return null;
}

/**
 * Detect platform by running a cpuinfo matching script on the device.
 */
async function detectFromCpuinfo(adb: Adb): Promise<string> {
	try {
		const output = await shell(adb, DETECTION_SCRIPT);
		const platform = output.trim().split('\n').pop()?.trim() ?? '';
		if (platform) {
			adbLog.info(`Platform detected from cpuinfo: ${platform}`);
		}
		return platform;
	} catch (e) {
		adbLog.warn(`cpuinfo platform detection failed: ${e}`);
		return '';
	}
}

/** Environment variables parsed from MinUI.pak/launch.sh. */
export interface MinUIEnv {
	sdcardPath: string;
	ldLibraryPath: string;
}

/**
 * Read and parse environment variables from the device's MinUI.pak/launch.sh.
 * Extracts SDCARD_PATH and LD_LIBRARY_PATH, resolving shell variables to
 * their concrete values. Falls back to defaults derived from basePath.
 */
export async function parseMinUIEnv(
	adb: Adb,
	platform: string,
	basePath: string
): Promise<MinUIEnv> {
	const systemDir = `${basePath}/.system/${platform}`;
	const launchSh = `${systemDir}/paks/MinUI.pak/launch.sh`;
	const defaults: MinUIEnv = {
		sdcardPath: basePath,
		ldLibraryPath: `${systemDir}/lib`
	};

	let content: string;
	try {
		content = await shell(adb, `cat ${launchSh}`);
	} catch (e) {
		adbLog.warn(`Failed to read ${launchSh}: ${e}`);
		return defaults;
	}

	const { honored, ignored } = collectAssignments(content);

	if (honored.size === 0 && ignored.size === 0) {
		// The raw `shell:` service merges stderr into stdout and carries no exit
		// code, so a missing or unreadable script comes back as BusyBox's error
		// text rather than throwing. Enumerating every possible error string is
		// futile, so always echo what came back — the recognizable ones only
		// pick the severity. Without this the text appears nowhere: `shell()`
		// logs the command and length, not the content.
		const trimmed = content.trim();
		const excerpt = trimmed.slice(0, 200) || '(empty)';
		if (!trimmed || /(can't open|No such file|Permission denied)/i.test(trimmed)) {
			adbLog.warn(`Could not read ${launchSh} — device returned: ${excerpt}`);
		} else {
			adbLog.debug(`No environment assignments in ${launchSh} — device returned: ${excerpt}`);
		}
	}

	// Record what the script actually said, including values we deliberately
	// skipped. This is the detail needed to diagnose an unfamiliar platform
	// from a copied log alone, so it must not hide a value the script does set.
	const describe = (name: string) => {
		const value = honored.get(name);
		const bare = ignored.get(name);
		if (value !== undefined)
			return bare !== undefined ? `${value} (also set bare: ${bare})` : value;
		return bare !== undefined ? `${bare} (ignored: not exported)` : '(unset)';
	};
	adbLog.debug(
		`launch.sh raw: SDCARD_PATH=${describe('SDCARD_PATH')}, ` +
			`LD_LIBRARY_PATH=${describe('LD_LIBRARY_PATH')}`
	);

	// Resolve the mount point first — everything else derives from it. Only the
	// detected platform is pinned at this stage, since the mount point is the
	// value we are trying to establish.
	let sdcardPath = resolveVar('SDCARD_PATH', honored, new Map([['PLATFORM', platform]])) ?? '';

	// The script may route the mount through a variable that only exists at
	// runtime (h700 uses $COMPAT_SDCARD_PATH). Trust the script only when it
	// yields an absolute path that is actually present on the device;
	// otherwise keep the mount point device detection measured.
	if (!sdcardPath.startsWith('/') || !(await pathExists(adb, sdcardPath))) {
		if (sdcardPath && sdcardPath !== basePath) {
			const unset = [...new Set(unresolvedNames(sdcardPath))];
			const detail = unset.length
				? `unset variable(s): ${unset.join(', ')}`
				: 'path not present on device';
			adbLog.warn(
				`SDCARD_PATH "${sdcardPath}" from ${launchSh} is unusable (${detail}); using ${basePath}`
			);
		}
		sdcardPath = defaults.sdcardPath;
	}

	// Values measured from the device outrank the script's own assignments,
	// which may be command substitutions or set inside a branch we cannot
	// evaluate. SYSTEM_PATH is rebuilt from the mount point we settled on so it
	// can never disagree with sdcardPath.
	const pinned = new Map<string, string>([
		['PLATFORM', platform],
		['SDCARD_PATH', sdcardPath],
		['SYSTEM_PATH', `${sdcardPath}/.system/${platform}`]
	]);

	// Resolve any remaining alias for the mount point (e.g. $COMPAT_SDCARD_PATH),
	// then drop segments that still hold an unresolved variable — including the
	// `:$LD_LIBRARY_PATH` self-reference scripts append.
	const segments = (resolveVar('LD_LIBRARY_PATH', honored, pinned) ?? defaults.ldLibraryPath)
		.replace(/\$\{?\w*SDCARD_PATH\}?/g, sdcardPath)
		.split(':')
		.filter(Boolean);
	const usable: string[] = [];
	const dropped: string[] = [];
	for (const segment of segments) {
		(segment.includes('$') ? dropped : usable).push(segment);
	}
	const ldLibraryPath = usable.join(':') || defaults.ldLibraryPath;

	// A `:$LD_LIBRARY_PATH` self-reference is normal and expected; any other
	// dropped segment means the script depends on something set at runtime that
	// we could not determine, which shows up later as a library that fails to
	// load. Judge by the segment itself — a `$(...)` substitution yields no
	// variable name to report but is no less broken.
	const selfRef = dropped.filter((segment) => SELF_REFERENCE.test(segment));
	const unexpected = dropped.filter((segment) => !SELF_REFERENCE.test(segment));
	if (unexpected.length) {
		const names = [...new Set(unexpected.flatMap(unresolvedNames))];
		const detail = names.length ? ` — unset variable(s): ${names.join(', ')}` : '';
		adbLog.warn(`LD_LIBRARY_PATH: dropped unresolved segment(s) ${unexpected.join(', ')}${detail}`);
	}
	if (selfRef.length) {
		adbLog.debug(`LD_LIBRARY_PATH: dropped self-reference ${selfRef.join(', ')}`);
	}

	adbLog.info(`MinUI env: SDCARD_PATH=${sdcardPath}, LD_LIBRARY_PATH=${ldLibraryPath}`);
	return { sdcardPath, ldLibraryPath };
}

/** A segment consisting only of the `$LD_LIBRARY_PATH` self-reference. */
const SELF_REFERENCE = /^\$\{?LD_LIBRARY_PATH\}?$/;

/** Names of `$VAR` / `${VAR}` references left unexpanded in a resolved value. */
function unresolvedNames(value: string): string[] {
	return [...value.matchAll(/\$\{?(\w+)\}?/g)].map((m) => m[1]);
}

/** Values we return — honored only from an `export`, never a bare assignment. */
const EXPORT_REQUIRED = new Set(['SDCARD_PATH', 'LD_LIBRARY_PATH']);

/** Raw (unexpanded) assignments parsed out of a shell script. */
interface ScriptAssignments {
	/** Assignments used when resolving values. */
	honored: Map<string, string>;
	/**
	 * Values we return that appeared as a bare, non-exported assignment. A name
	 * can be present here and in `honored` if the script does both.
	 */
	ignored: Map<string, string>;
}

/**
 * Collect raw (unexpanded) `KEY=value` assignments from a shell script.
 *
 * Bare assignments are kept because some platforms route the mount point
 * through an intermediate variable (h700 uses COMPAT_SDCARD_PATH), but the
 * values we ultimately return must come from an `export` — otherwise we would
 * pick up an assignment from a conditional branch the device never takes.
 * Those skipped values are still reported separately so diagnostics can show
 * what the script said rather than claiming it said nothing.
 */
function collectAssignments(content: string): ScriptAssignments {
	const honored = new Map<string, string>();
	const ignored = new Map<string, string>();
	for (const line of content.split('\n').map((l) => l.trim())) {
		const match = line.match(/^(export\s+)?(\w+)=["']?([^"'\n]*)["']?/);
		if (!match) continue;
		const [, exported, name, value] = match;
		if (!exported && EXPORT_REQUIRED.has(name)) ignored.set(name, value);
		else honored.set(name, value);
	}
	return { honored, ignored };
}

/**
 * Resolve a variable to its concrete value, expanding references to other
 * variables. Returns undefined if the script never assigns it.
 */
function resolveVar(
	name: string,
	assignments: Map<string, string>,
	pinned: Map<string, string>
): string | undefined {
	const pinnedValue = pinned.get(name);
	if (pinnedValue !== undefined) return pinnedValue;
	const raw = assignments.get(name);
	if (raw === undefined) return undefined;
	// Seed the cycle guard with this name so a self-reference such as
	// `LD_LIBRARY_PATH=...:$LD_LIBRARY_PATH` is left unexpanded rather than
	// recursing forever.
	return expandVars(raw, assignments, pinned, new Set([name]));
}

/**
 * Expand `$VAR` and `${VAR}` references. Pinned names always win over the
 * script's own assignments; unknown names and reference cycles are left
 * untouched for the caller to handle.
 */
function expandVars(
	value: string,
	assignments: Map<string, string>,
	pinned: Map<string, string>,
	seen: ReadonlySet<string>
): string {
	return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced, bare) => {
		const name = braced ?? bare;
		const pinnedValue = pinned.get(name);
		if (pinnedValue !== undefined) return pinnedValue;
		const raw = assignments.get(name);
		if (raw === undefined || seen.has(name)) return whole;
		return expandVars(raw, assignments, pinned, new Set(seen).add(name));
	});
}

/** Cpuinfo platform detection script — fallback matching the NextUI updater. */
const DETECTION_SCRIPT = `
INFO=\`cat /proc/cpuinfo 2> /dev/null\`
case $INFO in
*"sun8i"*)
	if [ -d /usr/miyoo ]; then
		PLATFORM="my282"
	else
		PLATFORM="trimuismart"
	fi
	;;
*"SStar"*)
	PLATFORM="miyoomini"
	;;
*"TG5040"*|*"TG3040"*)
	PLATFORM="tg5040"
	;;
*"TG5050"*)
	PLATFORM="tg5050"
	;;
*"0xd03"*)
	PLATFORM="zero28"
	;;
*"0xd05"*)
	PLATFORM="my355"
	;;
esac
if [ -z "$PLATFORM" ] && [ -f /usr/trimui/bin/runtrimui.sh ]; then
	PLATFORM="tg5040"
fi
echo $PLATFORM
`.trim();
