import type { Adb } from '@yume-chan/adb';
import { shell } from './file-ops.js';
import { adbLog } from '$lib/stores/log.svelte.js';

/**
 * Detect the device platform by running a hardcoded detection script on the device.
 * Returns the platform string (e.g. "tg5040") or empty string if detection fails.
 */
export async function detectPlatform(adb: Adb): Promise<string> {
	try {
		const output = await shell(adb, DETECTION_SCRIPT);
		const platform = output.trim().split('\n').pop()?.trim() ?? '';
		return platform;
	} catch (e) {
		adbLog.warn(`Platform detection failed: ${e}`);
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
