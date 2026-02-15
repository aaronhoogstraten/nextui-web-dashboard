import type { Adb } from '@yume-chan/adb';
import { shell } from './file-ops.js';
import { adbLog } from '$lib/stores/log.svelte.js';

const UPDATER_URL =
	'https://raw.githubusercontent.com/LoveRetro/NextUI/refs/heads/main/skeleton/BOOT/common/updater';

/**
 * Extract the platform detection block from the NextUI updater script.
 * Takes everything from the CPUINFO read through the fallback logic,
 * strips the dangerous execution/shutdown lines, and appends `echo $PLATFORM`.
 */
function buildDetectionScript(updaterSource: string): string | null {
	const lines = updaterSource.split('\n');
	const extracted: string[] = [];
	let capturing = false;

	for (const line of lines) {
		// Start capturing at the cpuinfo read
		if (!capturing && line.includes('/proc/cpuinfo')) {
			capturing = true;
		}

		if (!capturing) continue;

		// Stop before the line that executes the platform-specific updater
		if (line.includes('$PLATFORM.sh') || line.includes('sysrq-trigger')) {
			break;
		}

		extracted.push(line);
	}

	if (extracted.length === 0) return null;

	extracted.push('echo $PLATFORM');
	return extracted.join('\n');
}

/**
 * Detect the device platform by fetching NextUI's updater script from GitHub
 * and running the platform detection logic on the device via ADB shell.
 *
 * Returns the platform string (e.g. "tg5040") or empty string if detection fails.
 */
export async function detectPlatform(adb: Adb): Promise<string> {
	let detectionScript: string | null = null;

	try {
		adbLog.info('Fetching NextUI updater script for platform detection...');
		const response = await fetch(UPDATER_URL);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const source = await response.text();
		detectionScript = buildDetectionScript(source);
		if (!detectionScript) {
			adbLog.warn('Could not extract platform detection block from updater script');
		}
	} catch (e) {
		adbLog.warn(`Failed to fetch updater script: ${e}`);
	}

	if (!detectionScript) {
		adbLog.warn('Using hardcoded platform detection fallback');
		detectionScript = FALLBACK_SCRIPT;
	}

	try {
		const output = await shell(adb, detectionScript);
		const platform = output.trim().split('\n').pop()?.trim() ?? '';
		return platform;
	} catch (e) {
		adbLog.warn(`Platform detection shell command failed: ${e}`);
		return '';
	}
}

/** Hardcoded fallback matching the updater script at commit:
 *  https://github.com/LoveRetro/NextUI/blob/89158fe541c8ddb09a504b20acf7cf14343b2ee6/skeleton/BOOT/common/updater
 */
const FALLBACK_SCRIPT = `
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
