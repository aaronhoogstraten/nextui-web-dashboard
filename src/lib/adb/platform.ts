import type { Adb } from '@yume-chan/adb';
import { shell } from './file-ops.js';
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
export async function parseMinUIEnv(adb: Adb, platform: string, basePath: string): Promise<MinUIEnv> {
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

	// Parse export KEY="value" or export KEY=value lines
	const exports = new Map<string, string>();
	for (const line of content.split('\n').map((l) => l.trim())) {
		const match = line.match(/^export\s+(\w+)=["']?([^"'\n]*)["']?/);
		if (match) exports.set(match[1], match[2]);
	}

	const sdcardPath = exports.get('SDCARD_PATH') || defaults.sdcardPath;
	const resolvedSystemDir = `${sdcardPath}/.system/${platform}`;

	// Resolve LD_LIBRARY_PATH — replace shell variables with concrete values
	let ldLibraryPath = exports.get('LD_LIBRARY_PATH') || defaults.ldLibraryPath;
	ldLibraryPath = ldLibraryPath
		.replace(/\$SYSTEM_PATH/g, resolvedSystemDir)
		.replace(/\$SDCARD_PATH/g, sdcardPath)
		.replace(/\$PLATFORM/g, platform)
		.replace(/:\$LD_LIBRARY_PATH/, '');

	adbLog.info(`MinUI env: SDCARD_PATH=${sdcardPath}, LD_LIBRARY_PATH=${ldLibraryPath}`);
	return { sdcardPath, ldLibraryPath };
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
