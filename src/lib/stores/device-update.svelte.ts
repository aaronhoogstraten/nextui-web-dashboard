import { getNextUIVersion, isConnected } from '$lib/stores/connection.svelte.js';
import { adbLog } from '$lib/stores/log.svelte.js';

let latestRelease: string = $state('');
let dismissed: boolean = $state(false);
let fetchStatus: 'idle' | 'fetching' | 'done' | 'error' = $state('idle');

/** Parse "NextUI-YYYYMMDD-N" → [YYYYMMDD, N] for comparison. */
function parseNextUIVersion(str: string): [number, number] | null {
	const m = str.match(/NextUI-(\d{8})-(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2])];
}

function isOlderThan(device: string, latest: string): boolean {
	const d = parseNextUIVersion(device);
	const l = parseNextUIVersion(latest);
	if (!d || !l) return false;
	if (d[0] !== l[0]) return d[0] < l[0];
	return d[1] < l[1];
}

export function isDeviceUpdateAvailable(): boolean {
	const deviceVersion = getNextUIVersion().split('\n')[0];
	return (
		isConnected() &&
		fetchStatus === 'done' &&
		!dismissed &&
		isOlderThan(deviceVersion, latestRelease)
	);
}

export function getLatestNextUIVersion(): string {
	return latestRelease;
}

export function dismissDeviceUpdate(): void {
	dismissed = true;
}

export async function checkForDeviceUpdate(): Promise<void> {
	if (fetchStatus !== 'idle') return;
	fetchStatus = 'fetching';
	try {
		const res = await fetch('https://api.github.com/repos/LoveRetro/NextUI/releases/latest');
		if (!res.ok) {
			fetchStatus = 'error';
			return;
		}
		const data = await res.json();
		const assets: { name: string }[] = data.assets ?? [];
		const match = assets
			.map((a) => a.name.match(/^(NextUI-\d{8}-\d+)/))
			.find((m) => m !== null);
		latestRelease = match ? match[1] : '';
		adbLog.info(`Latest NextUI release: ${latestRelease || '(not found)'}`);
		fetchStatus = 'done';
	} catch {
		fetchStatus = 'error';
	}
}
