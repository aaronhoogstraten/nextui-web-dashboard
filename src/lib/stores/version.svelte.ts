import { base } from '$app/paths';

export const APP_VERSION: string = __APP_VERSION__;

const POLL_INTERVAL = 60 * 60 * 1000; // 60 minutes

let latestVersion: string = $state(APP_VERSION);
let updateAvailable: boolean = $state(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;

async function checkForUpdate() {
	try {
		const res = await fetch(`${base}/version.json`, { cache: 'no-store' });
		if (!res.ok) return;
		const data = await res.json();
		if (data.version && data.version !== APP_VERSION) {
			latestVersion = data.version;
			updateAvailable = true;
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = undefined;
			}
		}
	} catch {
		// silently ignore fetch errors
	}
}

// Start polling only in production
if (typeof window !== 'undefined' && APP_VERSION !== 'dev') {
	checkForUpdate();
	pollTimer = setInterval(checkForUpdate, POLL_INTERVAL);
}

export function isUpdateAvailable(): boolean {
	return updateAvailable;
}

export function getLatestVersion(): string {
	return latestVersion;
}
