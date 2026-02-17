import type { Adb } from '@yume-chan/adb';
import { listDirectory, shell } from './file-ops.js';
import { DEVICE_PATHS } from './types.js';
import { adbLog } from '$lib/stores/log.svelte.js';

/**
 * Detect the device platform.
 *
 * Primary method: look for the platform subdirectory under .userdata/ that
 * contains `msettings.bin` (e.g. `.userdata/tg5040/msettings.bin`). This uses
 * only the sync API — no shell execution required.
 *
 * Fallback: run a hardcoded cpuinfo detection script (matching NextUI's
 * updater logic) on the device via ADB shell.
 *
 * Returns the platform string (e.g. "tg5040") or empty string if detection fails.
 */
export async function detectPlatform(adb: Adb): Promise<string> {
	// Primary: find the .userdata/{platform}/msettings.bin file
	const platform = await detectFromUserdata(adb);
	if (platform) return platform;

	// Fallback: cpuinfo shell script
	adbLog.warn('Primary platform detection failed, falling back to cpuinfo script');
	return detectFromCpuinfo(adb);
}

/**
 * Detect platform by scanning .userdata/ for a subdirectory containing `msettings.bin`.
 * Skips known non-platform dirs (shared).
 */
async function detectFromUserdata(adb: Adb): Promise<string> {
	try {
		const entries = await listDirectory(adb, DEVICE_PATHS.userdata);
		const candidates: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory || entry.name.startsWith('.') || entry.name === 'shared') continue;
			try {
				const children = await listDirectory(adb, `${DEVICE_PATHS.userdata}/${entry.name}`);
				if (children.some((c) => c.isFile && c.name === 'msettings.bin')) {
					candidates.push(entry.name);
				}
			} catch {
				// Skip unreadable subdirs
			}
		}
		if (candidates.length === 1) {
			adbLog.info(`Platform detected from .userdata directory: ${candidates[0]}`);
			return candidates[0];
		}
		if (candidates.length > 1) {
			adbLog.warn(`Multiple platform directories found in .userdata: ${candidates.join(', ')}`);
		}
	} catch (e) {
		adbLog.warn(`Failed to scan .userdata directory: ${e}`);
	}
	return '';
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

/** Platform detection script matching the NextUI updater at https://github.com/LoveRetro/NextUI/blob/main/skeleton/BOOT/common/updater */
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
