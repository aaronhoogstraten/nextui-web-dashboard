import type { Adb } from '@yume-chan/adb';
import { pathExists, shell } from './file-ops.js';
import { adbLog } from '$lib/stores/log.svelte.js';

const TMP_NEXT = '/tmp/next';

/**
 * Launch a pak via the device's native pak-launching mechanism.
 * Writes `sh <launchScriptPath>` to /tmp/next and kills nextui.elf, which
 * triggers MinUI.pak's main loop to execute the pak with the full system
 * environment — identical to how paks launch from the device menu.
 * Throws if another pak is already running (/tmp/next exists).
 */
export async function launchPakNative(adb: Adb, launchScriptPath: string): Promise<void> {
	if (await pathExists(adb, TMP_NEXT)) {
		throw new Error(
			'Cannot launch pak: another pak is currently running. Return to the NextUI menu first.'
		);
	}

	const cmd = `sh ${launchScriptPath}`;
	await shell(adb, `echo '${cmd}' > ${TMP_NEXT}`);

	const written = (await shell(adb, `cat ${TMP_NEXT}`)).trim();
	if (written !== cmd) {
		throw new Error(`Failed to write launch command to ${TMP_NEXT} (got: "${written}")`);
	}

	await shell(adb, 'killall -9 nextui.elf');
	adbLog.info(`Launched pak: ${launchScriptPath}`);
}

/**
 * Poll until /tmp/next is removed — MinUI.pak's main loop deletes it only
 * after the currently running pak exits. Use this after stopping one pak
 * before launching another via launchPakNative.
 */
export async function waitForPakSlotFree(adb: Adb, timeoutMs = 10000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!(await pathExists(adb, TMP_NEXT))) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`Timed out waiting for pak slot to free (${TMP_NEXT} still present)`);
}
